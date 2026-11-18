/**
 * Queue draining: the shared path that turns queued spikes and pending clips
 * into finished files with ffmpeg, using the broadcaster's archive VOD.
 *
 * Both the renderer job and the collector call this. The collector needs it
 * because a moment that the live ring buffer could not cut (no coverage, a
 * render slot already busy mid-burst, or a snapshot that had scrolled away) has
 * no other way to become a clip once the job that detected it has moved on.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { log } from "./config.js";
import type { AgentSettings, ClipforgeApi, QueueClip, QueueSpike } from "./api.js";
import type { TwitchVod } from "./twitch.js";
import { extractAudio, renderClip, sampleFrames, thumbnail } from "./ffmpeg.js";
import { buildAss, buildCaptionAss } from "./subtitles.js";

/**
 * Twitch only publishes a broadcast as an archive VOD once the stream ends, so
 * a moment detected mid-stream legitimately has nothing to cut from yet. Those
 * stay queued and are retried; after this long we accept the archive is never
 * coming (VODs disabled or expired) and write the moment off.
 */
export const MAX_VOD_WAIT_SEC = 12 * 3600;

export type Outcome = "done" | "deferred" | "skipped";

export interface DrainOptions {
  api: ClipforgeApi;
  vod: TwitchVod;
  limit?: number;
  /** Ignore spikes younger than this: the live path is probably cutting them. */
  minSpikeAgeSec?: number;
}

export interface DrainResult {
  hadWork: boolean;
  analyzed: number;
  rendered: number;
  deferred: number;
  errors: string[];
}

const ageSeconds = (tsUnix: number) => Date.now() / 1000 - tsUnix;

async function failSpike(api: ClipforgeApi, id: string, reason: string): Promise<void> {
  log(`spike ${id} failed: ${reason}`);
  await api.setSpikeStatus(id, "failed").catch(() => {});
}

/** Sample the VOD, ask the server to assess the moment, and get a clip id back. */
async function analyzeSpike(
  api: ClipforgeApi,
  vod: TwitchVod,
  spike: QueueSpike,
  workDir: string,
): Promise<Outcome> {
  if (spike.capture_mode === "chat_only") {
    await api.setSpikeStatus(spike.id, "skipped");
    log(`spike ${spike.id}: channel is chat-only, skipping`);
    return "skipped";
  }

  const found = await vod.findVodFor(spike.channel_id, spike.ts_unix);
  if (!found) {
    const age = ageSeconds(spike.ts_unix);
    if (age > MAX_VOD_WAIT_SEC) {
      await failSpike(api, spike.id, "no archive VOD covers this moment (chat-only capture)");
      return "skipped";
    }
    log(
      `spike ${spike.id}: no archive VOD yet (${Math.round(age / 60)} min old, stream may still be live) ` +
        `- keeping it queued for a later pass`,
    );
    return "deferred";
  }

  const playlist = await vod.playlistFor(found.video.id);
  const start = Math.max(0, found.offset - 15);

  const frames = await sampleFrames(playlist, start, 30, 0.4, workDir);
  const audio = await extractAudio(playlist, start, 30, workDir);

  log(`spike ${spike.id}: sampled ${frames.length} frames, audio ${audio ? audio.length : 0} bytes`);

  const result = await api.analyze(spike.id, {
    frames: frames.map((f) => f.toString("base64")),
    audioBase64: audio ? audio.toString("base64") : undefined,
  });

  if (result.skipped) {
    log(`spike ${spike.id}: ${result.reason}`);
    return "skipped";
  }
  return result.clipId ? "done" : "skipped";
}

async function renderClipJob(
  api: ClipforgeApi,
  vod: TwitchVod,
  clip: QueueClip,
  settings: AgentSettings,
  workDir: string,
): Promise<Outcome> {
  if (!clip.channel_id || !clip.source_ts) {
    log(`clip ${clip.id}: missing channel or timestamp`);
    await api.failClip(clip.id, "clip has no channel or timestamp");
    return "skipped";
  }

  const found = await vod.findVodFor(clip.channel_id, clip.source_ts);
  if (!found) {
    const created = clip.created_at ? Date.parse(clip.created_at) / 1000 : clip.source_ts;
    const age = ageSeconds(Number.isFinite(created) ? created : clip.source_ts);
    if (age > MAX_VOD_WAIT_SEC) {
      await api.failClip(clip.id, "no archive VOD covers this moment, so capture is unavailable");
      return "skipped";
    }
    log(`clip ${clip.id}: no archive VOD yet - keeping it pending for a later pass`);
    return "deferred";
  }

  const playlist = await vod.playlistFor(found.video.id);

  // start_offset/end_offset are absolute unix seconds set by the analyser.
  const startOffset = clip.start_offset ?? clip.source_ts;
  const endOffset = clip.end_offset ?? startOffset + settings.clipDurationSec;
  // start_offset may sit before or after the spike, so translate it into the
  // VOD rather than always rewinding from the spike.
  const start = Math.max(0, found.offset + (startOffset - clip.source_ts));
  const duration = Math.max(6, Math.min(60, endOffset - startOffset));

  // Transcript was captured during analysis and stored on the clip.
  const transcript = clip.transcript ?? "";

  const assPath = path.join(workDir, "subs.ass");
  const ass = transcript
    ? buildAss(transcript, duration, settings.subtitleStyle)
    : buildCaptionAss(clip.caption ?? clip.title ?? "", duration);
  await writeFile(assPath, ass, "utf8");

  const outPath = path.join(workDir, "clip.mp4");
  await renderClip({
    input: playlist,
    startSec: start,
    durationSec: duration,
    outPath,
    assPath,
    aspect: settings.aspectRatio,
    cropMode: "blur",
  });

  const thumbPath = path.join(workDir, "thumb.jpg");
  await thumbnail(outPath, thumbPath);

  const video = await readFile(outPath);
  const thumb = await readFile(thumbPath).catch(() => null);

  await api.uploadClip(clip.id, video, thumb, {
    durationMs: Math.round(duration * 1000),
    width: settings.aspectRatio === "9:16" ? 1080 : settings.aspectRatio === "1:1" ? 1080 : 1920,
    height: settings.aspectRatio === "9:16" ? 1920 : 1080,
  });

  log(`clip ${clip.id}: rendered ${(video.length / 1048576).toFixed(1)} MB, ${duration.toFixed(1)}s`);
  return "done";
}

/** Works through one batch of queued spikes and pending clips. */
export async function drainQueue(opts: DrainOptions): Promise<DrainResult> {
  const { api, vod } = opts;
  const limit = Math.max(1, Math.min(opts.limit ?? 3, 10));
  const minSpikeAge = opts.minSpikeAgeSec ?? 0;

  const result: DrainResult = {
    hadWork: false,
    analyzed: 0,
    rendered: 0,
    deferred: 0,
    errors: [],
  };

  const queue = await api.queue(limit);
  if (!queue.spikes.length && !queue.clips.length) return result;
  result.hadWork = true;

  if (!vod.configured) {
    throw new Error(
      "no Twitch access: TWITCH_CLIENT_ID/SECRET unset and no usable CLIPFORGE_BASE_URL + INGEST_TOKEN",
    );
  }

  const spikes = queue.spikes.filter(
    (s) => !minSpikeAge || ageSeconds(s.ts_unix) >= minSpikeAge,
  );
  // Twitch only publishes a broadcast as an archive once it ends, so a moment
  // from a channel that is still live has nothing to cut from yet. Checking
  // that here saves a pointless videos lookup on every pass of a long stream.
  const liveLogins = new Set(
    queue.channels.filter((c) => c.is_live === 1).map((c) => c.login.toLowerCase()),
  );
  if (!spikes.length && !queue.clips.length) {
    result.hadWork = false;
    return result;
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "clipforge-render-"));

  try {
    for (const spike of spikes) {
      try {
        if (liveLogins.has(spike.channel_login.toLowerCase())) {
          result.deferred++;
          continue;
        }
        const outcome = await analyzeSpike(api, vod, spike, workDir);
        if (outcome === "done") result.analyzed++;
        else if (outcome === "deferred") result.deferred++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`analyze ${spike.id}: ${message}`);
        await failSpike(api, spike.id, message);
      }
    }

    for (const clip of queue.clips) {
      try {
        const outcome = await renderClipJob(api, vod, clip, queue.settings, workDir);
        if (outcome === "done") result.rendered++;
        else if (outcome === "deferred") result.deferred++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`render ${clip.id}: ${message}`);
        log(`clip ${clip.id} failed: ${message}`);
        await api.failClip(clip.id, message);
        if (clip.spike_id) await api.setSpikeStatus(clip.spike_id, "failed").catch(() => {});
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  return result;
}

export function describeDrain(result: DrainResult): string {
  return [
    `analyzed ${result.analyzed}`,
    `rendered ${result.rendered}`,
    result.deferred ? `deferred ${result.deferred}` : "",
    result.errors.length ? `errors: ${result.errors.slice(0, 2).join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}
