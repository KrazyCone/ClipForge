/**
 * Renders a clip from a local source file. Shared by the live path (collector,
 * working from the ring buffer) and usable from the VOD path too.
 */
import { rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import {
  audioLoudness,
  cutCopy,
  ffprobeStreamDurations,
  planLeadSkip,
  renderClip,
  thumbnail,
  extractAudio,
  sampleFrames,
  type RenderOptions,
} from "./ffmpeg.js";
import { buildAss, buildAssTimed, buildCaptionAss, shiftCaptions } from "./subtitles.js";
import { describeWebcam, parseWebcamBox } from "./webcam.js";
import type { AgentSettings, AnalyzeBeat, AnalyzeResult, QueueClip, TimedCaption } from "./api.js";
import type { ClipforgeApi } from "./api.js";
import { log } from "./config.js";

export interface ProduceOptions {
  api: ClipforgeApi;
  clip: Pick<
    QueueClip,
    "id" | "caption" | "title" | "start_offset" | "end_offset" | "source_ts" | "webcam_json"
  >;
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
  /** keep the footage this clip was cut from, so it can be re-cut later */
  saveSource?: boolean;
}

/**
 * Renders, and if the webcam composite is what failed (a busy runner hitting
 * the timeout, a source the crop chokes on) renders again with the normal
 * layout instead of losing the clip. The extra log line is also how the
 * operator can tell whether the webcam path actually ran.
 */
export async function renderWithFallback(opts: RenderOptions, label: string): Promise<void> {
  const webcam = opts.focusWebcam && opts.webcam ? opts.webcam : null;
  const started = Date.now();
  try {
    await renderClip(webcam ? { ...opts, timeoutMs: opts.timeoutMs ?? 180_000 } : opts);
  } catch (err) {
    if (!webcam) throw err;
    const message = err instanceof Error ? err.message : String(err);
    log(`${label}: webcam layout failed (${message.slice(0, 160)}) - retrying normally`);
    await renderClip({ ...opts, webcam: null, focusWebcam: false, timeoutMs: 180_000 });
  }
  log(`${label}: render took ${((Date.now() - started) / 1000).toFixed(0)}s`);

  const av = await ffprobeStreamDurations(opts.outPath).catch(() => null);
  if (av && av.audio > 0 && Math.abs(av.video - av.audio) > 0.35) {
    log(`${label}: warning - video ${av.video.toFixed(2)}s vs audio ${av.audio.toFixed(2)}s`);
  }
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
  // The render may skip a frozen opening. Measure it now, before the subtitle
  // file is written, so the cards move with the picture instead of running
  // ahead of it. The same number is handed to the renderer below.
  const lead = await planLeadSkip(sourceFile, startInSource, joined ? cuts : undefined);
  const leadSkip = joined ? lead.firstCut : lead.single;
  if (leadSkip > 0.05) {
    log(
      `live clip ${clip.id}: skipping ${leadSkip.toFixed(2)}s of frozen opening - subtitles shifted with it`,
    );
  }
  // Untimed text belongs to the whole analysed window, so it can only be
  // spread honestly over a single cut. A joined clip without timings gets the
  // caption card instead of subtitles that drift onto the wrong footage.
  const timed = opts.captions?.length ? shiftCaptions(opts.captions, leadSkip) : [];
  const ass = timed.length
    ? buildAssTimed(timed, duration, settings.subtitleStyle)
    : transcript && !joined
      ? buildAss(transcript, duration, settings.subtitleStyle)
      : buildCaptionAss(clip.caption ?? clip.title ?? "", duration);
  await writeFile(assPath, ass, "utf8");

  const outPath = path.join(workDir, "live.mp4");
  log(
    `live clip ${clip.id}: webcam ${describeWebcam(clip.webcam_json)}` +
      (settings.webcamFocus === true ? "" : " (enlargement off)") +
      `, ${joined ? `${cuts.length} cuts` : "single cut"}`,
  );
  await renderWithFallback(
    {
      input: sourceFile,
      startSec: startInSource,
      durationSec: duration,
      segments: joined ? cuts : undefined,
      outPath,
      assPath,
      leadSkip,
      aspect: settings.aspectRatio,
      cropMode: "blur",
      webcam: parseWebcamBox(clip.webcam_json),
      focusWebcam: settings.webcamFocus === true,
    },
    `live clip ${clip.id}`,
  );

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

  // Twitch only archives a stream once it ends, so this window is the only
  // thing a re-cut of a live moment can be cut from. A failure here costs the
  // re-cut, never the clip.
  if (opts.saveSource) {
    try {
      const from = Math.max(0, startInSource - 4);
      const room = opts.sourceDurationSec
        ? Math.max(1, opts.sourceDurationSec - from)
        : duration + 8;
      // More than the clip needs: a re-cut can ask for a longer clip, and the
      // beats it plans must still land inside this window.
      const keepFor = Math.min(duration + 25, room);
      const keepPath = path.join(workDir, "source.ts");
      await cutCopy(sourceFile, from, keepFor, keepPath);
      await api.uploadSource(clip.id, await readFile(keepPath), sourceStartSec + from);
      log(`live clip ${clip.id}: kept ${keepFor.toFixed(0)}s of source for re-cuts`);
    } catch (err) {
      log(
        `live clip ${clip.id}: could not keep source ` +
          `(${err instanceof Error ? err.message.slice(0, 200) : String(err)})`,
      );
    }
  }
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
