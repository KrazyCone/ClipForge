/**
 * Renders a clip from a local source file. Shared by the live path (collector,
 * working from the ring buffer) and usable from the VOD path too.
 */
import { rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { audioLoudness, renderClip, thumbnail, extractAudio, sampleFrames } from "./ffmpeg.js";
import { buildAss, buildAssTimed, buildCaptionAss } from "./subtitles.js";
import type { AgentSettings, AnalyzeBeat, AnalyzeResult, QueueClip, TimedCaption } from "./api.js";
import type { ClipforgeApi } from "./api.js";
import { log } from "./config.js";

export interface ProduceOptions {
  api: ClipforgeApi;
  clip: Pick<QueueClip, "id" | "caption" | "title" | "start_offset" | "end_offset" | "source_ts">;
  /** local file containing the footage */
  sourceFile: string;
  /** wall-clock unix seconds of the source file's first frame */
  sourceStartSec: number;
  /** length of the source file, used to clamp the cut inside it */
  sourceDurationSec?: number;
  settings: AgentSettings;
  workDir: string;
  /** transcript discovered during analysis, if any */
  transcript?: string;
  /** cuts relative to the spike peak, when the analyser planned several */
  beats?: AnalyzeBeat[];
  /** subtitles already remapped onto the assembled timeline */
  captions?: TimedCaption[];
}

export async function produceClipFromFile(opts: ProduceOptions): Promise<number> {
  const { api, clip, sourceFile, sourceStartSec, settings, workDir } = opts;

  const startOffset = clip.start_offset ?? sourceStartSec;
  const endOffset = clip.end_offset ?? startOffset + settings.clipDurationSec;
  // A segment-timing estimate can place the cut a little past the end of the
  // file, which makes ffmpeg write an empty clip. Keep it inside the footage.
  const latestStart = Math.max(0, (opts.sourceDurationSec ?? Number.POSITIVE_INFINITY) - 2);
  const startInSource = Math.max(0, Math.min(startOffset - sourceStartSec, latestStart));
  // Beat times are already source-file offsets, so the limit is the file's
  // total length, not what remains after startInSource.
  const available = opts.sourceDurationSec
    ? Math.max(0, opts.sourceDurationSec)
    : Number.POSITIVE_INFINITY;

  // Beat times are relative to the spike; the source file starts at
  // sourceStartSec, so translate them into the file before cutting.
  const spikeTs = clip.source_ts ?? startOffset;
  const cuts = (opts.beats ?? [])
    .map((beat) => {
      const from = Math.max(0, beat.startSec + spikeTs - sourceStartSec);
      const to = Math.min(available, Math.max(from + 1, beat.endSec + spikeTs - sourceStartSec));
      return { startSec: from, durationSec: to - from };
    })
    .filter((cut) => cut.durationSec >= 2);
  const joined = cuts.length > 1;
  const duration = joined
    ? Math.round(cuts.reduce((sum, cut) => sum + cut.durationSec, 0) * 10) / 10
    : Math.max(6, Math.min(60, endOffset - startOffset));

  const transcript = opts.transcript ?? "";
  const assPath = path.join(workDir, "subs.ass");
  // Untimed text belongs to the whole analysed window, so it can only be
  // spread honestly over a single cut. A joined clip without timings gets the
  // caption card instead of subtitles that drift onto the wrong footage.
  const ass = opts.captions?.length
    ? buildAssTimed(opts.captions, duration, settings.subtitleStyle)
    : transcript && !joined
      ? buildAss(transcript, duration, settings.subtitleStyle)
      : buildCaptionAss(clip.caption ?? clip.title ?? "", duration);
  await writeFile(assPath, ass, "utf8");

  const outPath = path.join(workDir, "live.mp4");
  await renderClip({
    input: sourceFile,
    startSec: startInSource,
    durationSec: duration,
    segments: joined ? cuts : undefined,
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

  log(
    `live clip ${clip.id}: ${(video.length / 1048576).toFixed(1)} MB, ${duration.toFixed(1)}s` +
      (joined ? ` joined from ${cuts.length} cuts` : ""),
  );
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
  /** start of this window relative to the spike peak, for beat timing */
  windowStartSec: number,
): Promise<AnalyzeResult | null> {
  // Frames and audio are independent: a snapshot that ffmpeg cannot seek into
  // used to abort the whole capture, even though the audio alone is enough to
  // judge the moment. Each half degrades on its own now.
  let frames: Buffer[] = [];
  try {
    frames = await sampleFrames(file, startSec, durationSec, frameSampleFps, workDir);
  } catch (err) {
    log(`frame sampling failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  }

  let audio: Buffer | null = null;
  try {
    audio = await extractAudio(file, startSec, durationSec, workDir);
  } catch {
    audio = null;
  }

  if (!frames.length && !audio) return null;

  // Loudness is what lets the analyser find the reaction inside the window
  // instead of guessing from chat alone. A decode failure is not fatal.
  const loudness = await audioLoudness(file, startSec, durationSec).catch(() => []);

  return api.analyze(spikeId, {
    frames: frames.map((f) => f.toString("base64")),
    audioBase64: audio ? audio.toString("base64") : undefined,
    windowStartSec,
    loudness: loudness.map((sample) => Math.round(sample.db * 10) / 10),
    loudnessBucketSec: 0.5,
  });
}

export async function cleanupWorkDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
