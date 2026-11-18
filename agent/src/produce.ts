/**
 * Renders a clip from a local source file. Shared by the live path (collector,
 * working from the ring buffer) and usable from the VOD path too.
 */
import { rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { renderClip, thumbnail, extractAudio, sampleFrames } from "./ffmpeg.js";
import { buildAss, buildCaptionAss } from "./subtitles.js";
import type { AgentSettings, QueueClip } from "./api.js";
import type { ClipforgeApi } from "./api.js";
import { log } from "./config.js";

export interface ProduceOptions {
  api: ClipforgeApi;
  clip: Pick<QueueClip, "id" | "caption" | "title" | "start_offset" | "end_offset">;
  /** local file containing the footage */
  sourceFile: string;
  /** wall-clock unix seconds of the source file's first frame */
  sourceStartSec: number;
  settings: AgentSettings;
  workDir: string;
  /** transcript discovered during analysis, if any */
  transcript?: string;
}

export async function produceClipFromFile(opts: ProduceOptions): Promise<number> {
  const { api, clip, sourceFile, sourceStartSec, settings, workDir } = opts;

  const startOffset = clip.start_offset ?? sourceStartSec;
  const endOffset = clip.end_offset ?? startOffset + settings.clipDurationSec;
  const startInSource = Math.max(0, startOffset - sourceStartSec);
  const duration = Math.max(6, Math.min(60, endOffset - startOffset));

  const transcript = opts.transcript ?? "";
  const assPath = path.join(workDir, "subs.ass");
  const ass = transcript
    ? buildAss(transcript, duration, settings.subtitleStyle)
    : buildCaptionAss(clip.caption ?? clip.title ?? "", duration);
  await writeFile(assPath, ass, "utf8");

  const outPath = path.join(workDir, "live.mp4");
  await renderClip({
    input: sourceFile,
    startSec: startInSource,
    durationSec: duration,
    outPath,
    assPath,
    aspect: settings.aspectRatio,
    cropMode: "blur",
  });

  const thumbPath = path.join(workDir, "live.jpg");
  await thumbnail(outPath, thumbPath);

  const video = await readFile(outPath);
  const thumb = await readFile(thumbPath).catch(() => null);

  await api.uploadClip(clip.id, video, thumb, {
    durationMs: Math.round(duration * 1000),
    width: settings.aspectRatio === "9:16" ? 1080 : settings.aspectRatio === "1:1" ? 1080 : 1920,
    height: settings.aspectRatio === "9:16" ? 1920 : 1080,
  });

  log(`live clip ${clip.id}: ${(video.length / 1048576).toFixed(1)} MB, ${duration.toFixed(1)}s`);
  return duration;
}

/** Sample frames + audio from a local file so the server can assess the moment. */
export async function analyseLocal(
  api: ClipforgeApi,
  spikeId: string,
  file: string,
  startSec: number,
  durationSec: number,
  frameSampleFps: number,
  workDir: string,
): Promise<{
  clipId?: string;
  transcript: string;
  clip?: { id: string; caption: string | null; title: string | null; start_offset: number | null; end_offset: number | null };
} | null> {
  const frames = await sampleFrames(file, startSec, durationSec, frameSampleFps, workDir);
  const audio = await extractAudio(file, startSec, durationSec, workDir);
  if (!frames.length && !audio) return null;

  const result = await api.analyze(spikeId, {
    frames: frames.map((f) => f.toString("base64")),
    audioBase64: audio ? audio.toString("base64") : undefined,
  });

  const transcript = result.transcript ?? "";
  if (result.skipped || !result.clipId || !result.clip) return { transcript };
  return { clipId: result.clipId, transcript, clip: result.clip };
}

export async function cleanupWorkDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
