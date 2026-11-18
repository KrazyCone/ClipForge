/**
 * Clip renderer. Runs on a schedule (GitHub Actions by default), pulls work from
 * the ClipForge API, and uses ffmpeg to cut and format vertical clips.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, log } from "./config.js";
import { ClipforgeApi } from "./api.js";
import type { QueueClip, QueueSpike } from "./api.js";
import { TwitchVod } from "./twitch.js";
import { extractAudio, renderClip, sampleFrames, thumbnail } from "./ffmpeg.js";
import { buildAss, buildCaptionAss } from "./subtitles.js";

async function failSpike(api: ClipforgeApi, id: string, reason: string) {
  log(`spike ${id} failed: ${reason}`);
  await api.setSpikeStatus(id, "failed").catch(() => {});
}

/** Sample the VOD, ask the server to assess the moment, and get a clip id back. */
async function analyzeSpike(
  api: ClipforgeApi,
  vod: TwitchVod,
  spike: QueueSpike,
  workDir: string,
): Promise<string | null> {
  if (spike.capture_mode === "chat_only") {
    await api.setSpikeStatus(spike.id, "skipped");
    log(`spike ${spike.id}: channel is chat-only, skipping`);
    return null;
  }

  const found = await vod.findVodFor(spike.channel_id, spike.ts_unix);
  if (!found) {
    await failSpike(api, spike.id, "no archive VOD covers this moment (chat-only capture)");
    return null;
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
    return null;
  }
  return result.clipId ?? null;
}

async function renderClipJob(
  api: ClipforgeApi,
  vod: TwitchVod,
  clip: QueueClip,
  settings: Awaited<ReturnType<ClipforgeApi["queue"]>>["settings"],
  workDir: string,
): Promise<void> {
  if (!clip.channel_id || !clip.source_ts) {
    log(`clip ${clip.id}: missing channel or timestamp`);
    return;
  }

  const found = await vod.findVodFor(clip.channel_id, clip.source_ts);
  if (!found) {
    throw new Error("no archive VOD covers this moment, so capture is unavailable");
  }

  const playlist = await vod.playlistFor(found.video.id);

  // start_offset/end_offset are absolute unix seconds set by the analyser.
  const startOffset = clip.start_offset ?? clip.source_ts;
  const endOffset = clip.end_offset ?? startOffset + settings.clipDurationSec;
  const leadIn = Math.max(0, clip.source_ts - startOffset);
  const start = Math.max(0, found.offset - leadIn);
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
}

async function main() {
  const cfg = loadConfig();
  const api = new ClipforgeApi(cfg);
  const vod = new TwitchVod();

  const queue = await api.queue(2);
  if (queue.spikes.length === 0 && queue.clips.length === 0) {
    log("queue empty");
    await api.recordRun("renderer", "idle", "queue empty");
    return;
  }
  if (!vod.configured) {
    log("no Twitch access - cannot resolve VODs (set TWITCH_CLIENT_ID/SECRET or use the site via INGEST_TOKEN)");
    await api.recordRun(
      "renderer",
      "failed",
      "no Twitch access: TWITCH_CLIENT_ID/SECRET unset and no usable INGEST_TOKEN",
    );
    process.exitCode = 1;
    return;
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "clipforge-"));
  let rendered = 0;
  let analyzed = 0;
  const errors: string[] = [];

  try {
    for (const spike of queue.spikes) {
      try {
        const clipId = await analyzeSpike(api, vod, spike, workDir);
        if (clipId) analyzed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`analyze ${spike.id}: ${message}`);
        await failSpike(api, spike.id, message);
      }
    }

    for (const clip of queue.clips) {
      try {
        await renderClipJob(api, vod, clip, queue.settings, workDir);
        rendered++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`render ${clip.id}: ${message}`);
        log(`clip ${clip.id} failed: ${message}`);
        await api.failClip(clip.id, message);
        if (clip.spike_id) await api.setSpikeStatus(clip.spike_id, "failed").catch(() => {});
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  const detail = `analyzed ${analyzed}, rendered ${rendered}${errors.length ? `, errors: ${errors.slice(0, 2).join(" | ")}` : ""}`;
  log(detail);
  await api.recordRun("renderer", errors.length ? "partial" : "ok", detail);
  if (errors.length && rendered === 0 && analyzed === 0) process.exitCode = 1;
}

void main().catch((err) => {
  log("renderer crashed", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
