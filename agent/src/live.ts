/**
 * Rolling live buffer.
 *
 * ffmpeg copies the live HLS into 2-second MPEG-TS segments in a temp
 * directory; a sweep deletes anything older than the window. Nothing is
 * re-encoded here, so the cost is disk I/O only. When the detector fires, the
 * relevant segments are concatenated into one local file and the normal render
 * path takes over - which is why a clip can land while the stream is still live.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, rm, stat, unlink, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ffmpeg, ffprobeDuration } from "./ffmpeg.js";
import { log } from "./config.js";

export interface Snapshot {
  /** concatenated local file */
  file: string;
  /** unix seconds of the first frame in that file */
  startSec: number;
  durationSec: number;
  /** temp directory holding the concatenated file - the caller must remove it */
  workDir: string;
}

/** No new segment for this long means the HLS copy has stalled, not that chat is quiet. */
const STALL_MS = 45_000;

export class LiveRecorder {
  private proc: ChildProcess | null = null;
  private sweep: NodeJS.Timeout | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private restart: NodeJS.Timeout | null = null;
  private lastSegmentAt = Date.now();
  private stopping = false;
  private lastError = "";
  private dir: string;
  /** consecutive failed respawns, reset once ffmpeg has run for a while */
  private failures = 0;
  private startedAt = 0;

  constructor(
    readonly login: string,
    private playlistUrl: string,
    /** how much footage to retain, seconds */
    private bufferSeconds = 180,
    /**
     * Re-signs the playlist. Twitch's HLS URL carries a short-lived token, so a
     * restart must fetch a new one instead of replaying the dead URL.
     */
    private refreshUrl?: () => Promise<string>,
  ) {
    this.dir = path.join(tmpdir(), `clipforge-buf-${login}`);
    this.playlistUrl = playlistUrl;
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.spawn();
    this.sweep = setInterval(() => void this.cleanup(), 10_000);
    this.stallTimer = setInterval(() => this.checkStall(), 15_000);
    log(`live buffer started for ${this.login} (${this.bufferSeconds}s window)`);
  }

  private spawn(): void {
    if (this.stopping) return;
    this.startedAt = Date.now();
    this.lastSegmentAt = Date.now();
    this.lastError = "";
    const proc = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel", "error",
        // Reconnect flags matter on a live HLS that can hiccup.
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-i", this.playlistUrl,
        "-c", "copy",
        "-f", "segment",
        "-segment_time", "2",
        "-reset_timestamps", "1",
        path.join(this.dir, "seg_%06d.ts"),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.lastError = text.slice(-300);
    });

    proc.on("close", () => {
      if (this.stopping) return;
      // An expired token fails immediately, so a long run means the fault was
      // transient; a short one means the URL itself has to be replaced.
      if (Date.now() - this.startedAt > 60_000) this.failures = 0;
      this.failures = Math.min(this.failures + 1, 6);
      const delay = Math.min(60_000, 3_000 * 2 ** (this.failures - 1));
      log(
        `live buffer for ${this.login} exited, retrying in ${delay}ms` +
          (this.lastError ? `: ${redactUrl(this.lastError)}` : ""),
      );
      this.restart = setTimeout(() => void this.restartNow(), delay);
    });

    this.proc = proc;
  }

  /**
   * A days-long stream will eventually outlive something: the signed playlist
   * token, the CDN connection, or the segment muxer. ffmpeg does not always
   * exit when that happens - it just stops producing segments - so the writer
   * has to be killed and respawned or live capture silently ends.
   */
  private checkStall(): void {
    if (this.stopping || !this.proc || this.proc.exitCode !== null) return;
    if (Date.now() - this.startedAt < STALL_MS) return;
    const silentMs = Date.now() - this.lastSegmentAt;
    if (silentMs < STALL_MS) return;
    log(`live buffer for ${this.login}: no new segment for ${Math.round(silentMs / 1000)}s - restarting capture`);
    try {
      this.proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }

  /** Refresh the signed URL before respawning, so a 404 is not replayed forever. */
  private async restartNow(): Promise<void> {
    if (this.stopping) return;
    // The segment muxer numbers files from zero on every spawn, so a stale
    // directory would be overwritten mid-read. A restart is a coverage gap
    // anyway, so start clean.
    await rm(this.dir, { recursive: true, force: true }).catch(() => {});
    await mkdir(this.dir, { recursive: true }).catch(() => {});
    if (this.failures >= 1 && this.refreshUrl) {
      try {
        this.playlistUrl = await this.refreshUrl();
        log(`live buffer for ${this.login}: playlist token refreshed`);
      } catch (err) {
        log(
          `live buffer for ${this.login}: playlist refresh failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.spawn();
  }

  private async cleanup(): Promise<void> {
    const cutoff = Date.now() - (this.bufferSeconds + 20) * 1000;
    try {
      for (const name of await readdir(this.dir)) {
        if (!name.endsWith(".ts")) continue;
        const full = path.join(this.dir, name);
        const info = await stat(full);
        if (info.mtimeMs > this.lastSegmentAt) this.lastSegmentAt = info.mtimeMs;
        if (info.mtimeMs < cutoff) await unlink(full).catch(() => {});
      }
    } catch {
      /* directory may be gone during shutdown */
    }
  }

  /**
   * Concatenate the segments covering [tsSec - preSec, tsSec + postSec].
   * Returns null when the buffer does not reach back far enough - the caller
   * then falls back to the VOD path rather than producing a truncated clip.
   */
  async snapshot(tsSec: number, preSec: number, postSec: number): Promise<Snapshot | null> {
    const fromMs = (tsSec - preSec - 3) * 1000;
    const toMs = (tsSec + postSec + 3) * 1000;

    const files: { full: string; mtimeMs: number }[] = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".ts")) continue;
      const full = path.join(this.dir, name);
      const info = await stat(full);
      files.push({ full, mtimeMs: info.mtimeMs });
    }

    const picked = selectSegments(files, fromMs, toMs);
    if (picked.length < 2) return null;

    // A segment's mtime is when it finished writing, so its start is
    // mtime - duration. That anchors absolute time to an offset in the file.
    const firstDuration = await ffprobeDuration(picked[0].full);
    if (firstDuration <= 0) return null;
    const startSec = picked[0].mtimeMs / 1000 - firstDuration;

    const work = await mkdtemp(path.join(tmpdir(), "clipforge-snap-"));
    const listPath = path.join(work, "list.txt");
    const list = picked.map((p) => `file '${p.full.replace(/'/g, "'\\''")}'`).join("\n");
    await writeFile(listPath, list, "utf8");

    const out = path.join(work, "moment.ts");
    try {
      await ffmpeg(
        ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-y", out],
        60_000,
      );
    } catch (err) {
      log(`snapshot concat failed for ${this.login}: ${err instanceof Error ? err.message : err}`);
      return null;
    }

    let duration = 0;
    for (const p of picked) duration += await ffprobeDuration(p.full);

    return { file: out, startSec, durationSec: duration, workDir: work };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sweep) clearInterval(this.sweep);
    if (this.stallTimer) clearInterval(this.stallTimer);
    if (this.restart) clearTimeout(this.restart);
    try {
      this.proc?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Signed playlist URLs carry a short-lived token; keep it out of the log. */
function redactUrl(text: string): string {
  return text.replace(/https?:\/\/\S+/g, (url) => url.replace(/\?.*$/, "?…")).slice(-240);
}

/**
 * Segments whose *completion* time falls inside the window. A segment's mtime is
 * when it finished being written, so a segment that started before the window
 * but ends inside it is correctly included.
 */
export function selectSegments<T extends { mtimeMs: number }>(
  files: T[],
  fromMs: number,
  toMs: number,
): T[] {
  return files.filter((f) => f.mtimeMs >= fromMs && f.mtimeMs <= toMs).sort((a, b) => a.mtimeMs - b.mtimeMs);
}
