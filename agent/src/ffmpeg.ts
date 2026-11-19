import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { log } from "./config.js";
import type { WebcamBox } from "./webcam.js";

/**
 * Fonts are installed next to ffmpeg in the workflow image. Passing the
 * directory explicitly makes libass load the TTF even when fontconfig's cache
 * is unavailable, which otherwise makes it draw nothing and fail silently.
 */
const FONTS_DIR = process.env.CLIPFORGE_FONTS_DIR || "/usr/share/fonts/truetype/dejavu";

function assFilter(assPath: string): string {
  return existsSync(FONTS_DIR)
    ? `ass=${assPath}:fontsdir=${FONTS_DIR}`
    : `ass=${assPath}`;
}

export function ffmpeg(args: string[], timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 60_000) stderr = stderr.slice(-40_000);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

/** Run ffmpeg and capture stdout, for raw PCM. */
export function ffmpegBuffer(args: string[], timeoutMs = 60_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`));
    });
  });
}

/**
 * Per-bucket loudness of the audio in dBFS. Reaction peaks (laughter, a
 * scream, an explosion) are the most reliable local signal for "where is the
 * interesting part", and unlike the chat spike they have a timestamp.
 */
export async function audioLoudness(
  input: string,
  startSec: number,
  durationSec: number,
  bucketSec = 0.5,
): Promise<{ atSec: number; db: number }[]> {
  const rate = 8_000;
  const pcm = await ffmpegBuffer(
    [
      "-hide_banner", "-loglevel", "error",
      "-ss", Math.max(0, startSec).toFixed(2),
      "-t", Math.max(2, durationSec).toFixed(2),
      "-i", input,
      "-vn", "-ac", "1", "-ar", String(rate),
      "-f", "s16le", "pipe:1",
    ],
    120_000,
  );

  const samplesPerBucket = Math.max(1, Math.round(rate * bucketSec));
  const bytesPerBucket = samplesPerBucket * 2;
  const out: { atSec: number; db: number }[] = [];
  for (let offset = 0; offset + bytesPerBucket <= pcm.length; offset += bytesPerBucket) {
    let sum = 0;
    for (let i = 0; i < samplesPerBucket; i++) {
      const v = pcm.readInt16LE(offset + i * 2) / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / samplesPerBucket);
    const db = rms > 0 ? 20 * Math.log10(rms) : -70;
    out.push({ atSec: offset / 2 / rate, db: Math.max(-70, Math.min(0, db)) });
  }
  return out;
}

/** Whether the source actually carries an audio stream. */
export function ffprobeHasAudio(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
    proc.on("error", () => resolve(false));
    proc.on("close", () => resolve(out.trim().length > 0));
  }).then(async (found) => {
    if (found) return true;
    // Some ffprobe builds cannot read MPEG-TS at all and return nothing, even
    // though the file has audio. ffmpeg's own stream listing is a second
    // opinion; without it a live clip would silently render without sound.
    const info = await ffmpeg(
      ["-hide_banner", "-i", file, "-t", "0.1", "-f", "null", "-"],
      30_000,
    ).catch((err: Error) => err.message);
    return /Stream #\d+:\d+.*: Audio:/.test(info);
  });
}

/** First presentation time of each stream in the source. */
export function ffprobeStreamStarts(
  file: string,
): Promise<{ video: number; audio: number } | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "stream=codec_type,start_time",
        "-of", "json",
        file,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      try {
        const streams = (JSON.parse(out) as { streams?: { codec_type?: string; start_time?: string }[] })
          .streams ?? [];
        const video = streams.find((s) => s.codec_type === "video");
        const audio = streams.find((s) => s.codec_type === "audio");
        if (!video || !audio) return resolve(null);
        resolve({ video: Number(video.start_time) || 0, audio: Number(audio.start_time) || 0 });
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * How long the picture at `startSec` stays on one identical frame before it
 * moves. A live snapshot can begin with a short stall - the same decoded frame
 * repeated while its audio runs on - and a player then shows one frozen image
 * for that whole moment even though the sound is fine.
 *
 * Small greyscale frames keep this cheap: about a second and a half of decode
 * at 10 fps, no encoding. Any pixel changing by more than a few levels counts
 * as motion, which a genuine freeze (bit-identical frames) never does.
 */
export async function frozenLeadSec(input: string, startSec: number, maxSec = 2): Promise<number> {
  const fps = 10;
  const width = 96;
  const height = 54;
  const frameBytes = width * height;
  const motion = 4;

  try {
    const raw = await ffmpegBuffer(
      [
        "-hide_banner", "-loglevel", "error",
        "-ss", Math.max(0, startSec).toFixed(3),
        "-t", maxSec.toFixed(2),
        "-i", input,
        "-an",
        "-vf", `fps=${fps},scale=${width}:${height}:flags=fast_bilinear,format=gray`,
        "-f", "rawvideo",
        "pipe:1",
      ],
      30_000,
    );

    const frames = Math.floor(raw.length / frameBytes);
    if (frames < 3) return 0;
    const first = raw.subarray(0, frameBytes);

    let moving = -1;
    for (let i = 1; i < frames && moving < 0; i++) {
      const frame = raw.subarray(i * frameBytes, (i + 1) * frameBytes);
      for (let p = 0; p < frameBytes; p++) {
        if (Math.abs(frame[p] - first[p]) >= motion) {
          moving = i;
          break;
        }
      }
    }
    // Still at the end of the probe: the whole opening is a hold, so there is
    // no later frame to start on and the cut is left where it is.
    if (moving < 1) return 0;
    const offset = moving / fps;
    return offset >= 0.15 ? Math.min(offset, maxSec - 0.1) : 0;
  } catch (err) {
    // A source this build cannot decode is not a reason to fail the render; it
    // just starts where it was planned to. The log line is how the operator can
    // tell the probe never ran.
    log(
      `frozen-start probe skipped: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
    );
    return 0;
  }
}

export interface LeadSkipPlan {
  /** seconds to skip at the start of a single cut */
  single: number;
  /** seconds to skip at the head of a joined clip (the first cut only) */
  firstCut: number;
}

/**
 * Measures how much frozen picture a render will skip. The caller needs this
 * *before* it writes the subtitle file, so the same number shifts both the
 * captions and the picture; otherwise the subtitles run ahead of the footage by
 * exactly the amount that was skipped.
 */
export async function planLeadSkip(
  input: string,
  startSec: number,
  segments?: { startSec: number; durationSec: number }[],
): Promise<LeadSkipPlan> {
  const cuts = (segments ?? []).filter((s) => s.durationSec >= 1);
  if (cuts.length > 1) {
    const firstCut = await frozenLeadSec(input, Math.max(0, cuts[0].startSec)).catch(() => 0);
    return { single: 0, firstCut };
  }

  // Stream start offsets only describe the beginning of the file, so they are
  // consulted only when the cut really is at the start; using them for a cut
  // hundreds of seconds into a live buffer is what shifted some clips' audio.
  let single = 0;
  const starts = await ffprobeStreamStarts(input).catch(() => null);
  if (starts && startSec < 2) {
    const gap = Math.min(2, Math.max(0, starts.video - starts.audio));
    if (gap > 0.08) single = gap;
  }
  single += await frozenLeadSec(input, startSec + single).catch(() => 0);
  return { single, firstCut: 0 };
}

/** Audio and video durations of a finished file, for sync verification. */
export function ffprobeStreamDurations(
  file: string,
): Promise<{ video: number; audio: number } | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "stream=codec_type,duration",
        "-of", "json",
        file,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      try {
        const streams = (JSON.parse(out) as { streams?: { codec_type?: string; duration?: string }[] })
          .streams ?? [];
        const video = streams.find((s) => s.codec_type === "video");
        const audio = streams.find((s) => s.codec_type === "audio");
        resolve({
          video: Number(video?.duration) || 0,
          audio: Number(audio?.duration) || 0,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

/** Sample JPEG frames across a window of the source. */
export async function sampleFrames(
  input: string,
  startSec: number,
  durationSec: number,
  fps: number,
  workDir: string,
): Promise<Buffer[]> {
  const outDir = path.join(workDir, "frames");
  await rm(outDir, { recursive: true, force: true });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });

  await ffmpeg([
    "-hide_banner",
    "-loglevel", "error",
    "-ss", startSec.toFixed(2),
    "-t", Math.max(2, durationSec).toFixed(2),
    "-i", input,
    "-vf", `fps=${Math.max(0.1, Math.min(2, fps))},scale=640:-2`,
    "-q:v", "4",
    path.join(outDir, "f_%03d.jpg"),
  ]);

  const files = (await readdir(outDir)).filter((f) => f.endsWith(".jpg")).sort();
  const frames: Buffer[] = [];
  for (const file of files.slice(0, 3)) {
    frames.push(await readFile(path.join(outDir, file)));
  }
  return frames;
}

/** Mono 16 kHz WAV, the format Whisper expects. */
export async function extractAudio(
  input: string,
  startSec: number,
  durationSec: number,
  workDir: string,
): Promise<Buffer | null> {
  const out = path.join(workDir, "audio.wav");
  try {
    await ffmpeg([
      "-hide_banner",
      "-loglevel", "error",
      "-ss", startSec.toFixed(2),
      "-t", Math.max(2, durationSec).toFixed(2),
      "-i", input,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-f", "wav",
      out,
    ]);
    return await readFile(out);
  } catch {
    // A VOD with no audio track is not fatal.
    return null;
  }
}

export interface RenderOptions {
  input: string;
  startSec: number;
  durationSec: number;
  /** Multiple cuts from the same source, joined in order. Takes precedence. */
  segments?: { startSec: number; durationSec: number }[];
  outPath: string;
  assPath: string | null;
  aspect: "9:16" | "1:1" | "16:9";
  cropMode: "blur" | "center";
  cropX?: "center" | "left" | "right";
  /** detected face cam, normalized to the source frame */
  webcam?: WebcamBox | null;
  /** stack an enlarged webcam band above the gameplay */
  focusWebcam?: boolean;
  /** hard limit for a slow render; the webcam pass gets a tighter budget */
  timeoutMs?: number;
  /**
   * Frozen lead already measured by `planLeadSkip`. Supplying it keeps the
   * picture and the subtitle file on the same skip; when omitted the render
   * measures it itself.
   */
  leadSkip?: number;
}

/**
 * Vertical render. `blur` keeps the whole frame visible over a blurred fill so
 * nothing is cropped away; `center`/`left`/`right` crop hard to the frame.
 */
export async function renderClip(opts: RenderOptions): Promise<void> {
  const { width, height } = dimsFor(opts.aspect);

  // Drop to 30 fps before scaling, blurring and compositing. A 1080p60 source
  // used to do all of that twice as often as the output needed, which is what
  // pushed busy live renders into the five-minute timeout.
  let videoFilter: string;
  if (opts.aspect === "16:9") {
    videoFilter = `fps=30,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  } else if (opts.cropMode === "blur") {
    videoFilter =
      `fps=30,split=2[bg][fg];` +
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=26[bgb];` +
      `[fg]scale=${width}:-2:force_original_aspect_ratio=decrease[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2`;
  } else {
    // Crop toward a third of the frame: left keeps a webcam column, right keeps
    // the right-hand HUD, center is the default.
    const anchor = opts.cropX === "left" ? 0 : opts.cropX === "right" ? 1 : 0.5;
    videoFilter =
      `fps=30,scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height}:(iw-${width})*${anchor}:(ih-${height})/2`;
  }

  const segments = (opts.segments ?? []).filter((s) => s.durationSec >= 1);
  // The stacked layout is built for the vertical canvas only.
  const webcam = opts.focusWebcam && opts.webcam && opts.aspect === "9:16" ? opts.webcam : null;

  if (segments.length > 1) {
    await renderJoined(opts, segments, videoFilter, webcam);
    return;
  }

  // A clip can open on a stretch of frozen picture while its audio runs on.
  // Two things cause it: the container starts the video stream later than the
  // audio, or the live snapshot simply repeats one frame for a moment. Both are
  // measured and skipped in the *video and the audio together*, so the cut
  // begins on real motion with the sound still in step with it.
  const durationStr = opts.durationSec.toFixed(3);
  const leadSkip =
    opts.leadSkip !== undefined
      ? Math.max(0, opts.leadSkip)
      : (await planLeadSkip(opts.input, opts.startSec)).single;
  if (leadSkip > 0.05) {
    log(`render starts ${leadSkip.toFixed(2)}s later: the source opens on a frozen picture`);
  }

  const normalisedVideo = `setpts=PTS-STARTPTS,fps=30,trim=duration=${durationStr},setpts=PTS-STARTPTS`;
  // No timestamp padding and no speed adaptation: both bend the audio away from
  // the picture. The one audio stream is folded to stereo at a fixed rate so a
  // 5.1 or mono source cannot come out warped.
  const normalisedAudio =
    `asetpts=PTS-STARTPTS,aresample=48000,` +
    `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
    `atrim=duration=${durationStr},asetpts=PTS-STARTPTS`;

  let filterComplex: string;
  if (webcam) {
    filterComplex = webcamChains("0:v", webcam, "v", opts.assPath, durationStr).join(";");
  } else {
    if (opts.assPath) videoFilter += `,${assFilter(opts.assPath)}`;
    filterComplex = `[0:v]${normalisedVideo},${videoFilter}[v]`;
  }

  await ffmpeg([
    "-hide_banner",
    "-loglevel", "error",
    "-ss", (opts.startSec + leadSkip).toFixed(3),
    // Extra read so the skipped lead does not shorten the clip.
    "-t", (opts.durationSec + leadSkip + 0.5).toFixed(2),
    "-i", opts.input,
    "-filter_complex", filterComplex,
    "-map", "[v]",
    // Only the first audio track: mapping every track at once plays them on top
    // of each other, which is another way a clip ends up sounding wrong.
    "-map", "0:a:0?",
    "-af", normalisedAudio,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "21",
    "-profile:v", "high",
    "-level", "4.1",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",
    // Browser-friendly start: a constant frame rate, no negative timestamps and
    // the index at the front of the file, so a player has a real frame at t=0
    // instead of holding the poster while it waits for one.
    "-fps_mode", "cfr",
    "-fflags", "+genpts",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
    "-y",
    opts.outPath,
  ], opts.timeoutMs ?? 240_000);
}

/**
 * Joins several cuts of one source into a single video. Each cut is its own
 * input so a long archive VOD is only decoded at the beats, not end to end.
 * The vertical/blur treatment is applied once after the join, and the subtitle
 * file covers the joined timeline.
 */
/**
 * Face-forward layout. The webcam is a smaller band that sits below the very
 * top of the frame instead of filling it, and the gameplay sits under that,
 * slightly narrower and higher than before so the two do not crowd each other.
 * The margin around both is the same frame, blurred, rather than black.
 *
 *   0                240   blurred backdrop
 *   240..640              face band (1080x400)
 *   670..1255             gameplay (1040 wide, aspect preserved)
 *   1255..1920            blurred backdrop - subtitles burn here
 */
const WC_FACE_H = 400;
const WC_FACE_Y = 240;
const WC_GAME_W = 1040;
const WC_GAME_Y = 670;

function webcamChains(
  source: string,
  box: WebcamBox,
  outLabel: string,
  assPath: string | null,
  /** set for a single cut: normalise the source before splitting it */
  durationStr?: string,
): string[] {
  const f = (n: number) => n.toFixed(4);
  const prep = durationStr
    ? `setpts=PTS-STARTPTS,fps=30,trim=duration=${durationStr},setpts=PTS-STARTPTS`
    : `fps=30`;
  return [
    `[${source}]${prep},split=3[wcFaceSrc][wcGameSrc][wcBgSrc]`,
    // The whole frame, blurred, is the backdrop for both bands: a top margin of
    // black looked like a broken encode.
    `[wcBgSrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
      `gblur=sigma=26[wcCanvas]`,
    // Fitted to the band's height and centred, never cropped to fill it: a short
    // wide band that covers its area slices the top of the head off, which is
    // how a correct detection still looked wrong.
    `[wcFaceSrc]crop=iw*${f(box.w)}:ih*${f(box.h)}:iw*${f(box.x)}:ih*${f(box.y)},` +
      `scale=-2:${WC_FACE_H},setsar=1[wcFace]`,
    `[wcGameSrc]scale=${WC_GAME_W}:-2:force_original_aspect_ratio=decrease,setsar=1[wcGameFit]`,
    `[wcCanvas][wcGameFit]overlay=(W-w)/2:${WC_GAME_Y}[wcStage]`,
    `[wcStage][wcFace]overlay=(W-w)/2:${WC_FACE_Y}${assPath ? `,${assFilter(assPath)}` : ""}[${outLabel}]`,
  ];
}

async function renderJoined(
  opts: RenderOptions,
  segments: { startSec: number; durationSec: number }[],
  videoFilter: string,
  webcam: WebcamBox | null,
): Promise<void> {
  const hasAudio = await ffprobeHasAudio(opts.input);
  const args = ["-hide_banner", "-loglevel", "error"];
  // Only the opening cut can show the frozen start the player sees, and it
  // keeps its planned length: the seek moves, the read window grows. The caller
  // passes the lead it already measured so the subtitles were shifted by it.
  const lead =
    opts.leadSkip !== undefined
      ? Math.max(0, opts.leadSkip)
      : await frozenLeadSec(opts.input, segments[0].startSec).catch(() => 0);
  const cuts = segments.map((segment, index) =>
    index === 0 && lead > 0 ? { ...segment, startSec: segment.startSec + lead } : segment,
  );
  for (const segment of cuts) {
    args.push(
      "-ss", Math.max(0, segment.startSec).toFixed(3),
      // Read one second of slack and trim in the graph instead. `-t` on the
      // input stops at a packet boundary, so each cut's audio could run a frame
      // or two longer than its video and every join moved the audio later.
      "-t", (segment.durationSec + 1).toFixed(2),
      "-i", opts.input,
    );
  }

  // Every cut gets exactly its planned duration, for video and audio alike,
  // with timestamps starting at zero. 1080p keeps the 9:16 foreground sharp.
  const chains: string[] = [];
  const pairLabels: string[] = [];
  for (let i = 0; i < cuts.length; i++) {
    const duration = cuts[i].durationSec.toFixed(3);
    chains.push(
      `[${i}:v]setpts=PTS-STARTPTS,fps=30,trim=duration=${duration},setpts=PTS-STARTPTS,` +
        `scale=1920:1080:force_original_aspect_ratio=decrease,` +
        `pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`,
    );
    pairLabels.push(`[v${i}]`);
    if (hasAudio) {
      chains.push(
        `[${i}:a]asetpts=PTS-STARTPTS,aresample=48000,` +
          `atrim=duration=${duration},asetpts=PTS-STARTPTS,` +
          `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`,
      );
      pairLabels.push(`[a${i}]`);
    }
  }
  // One concat for both streams keeps their segment boundaries identical.
  chains.push(
    hasAudio
      ? `${pairLabels.join("")}concat=n=${cuts.length}:v=1:a=1[vc][ac]`
      : `${pairLabels.join("")}concat=n=${cuts.length}:v=1:a=0[vc]`,
  );

  if (webcam) {
    chains.push(...webcamChains("vc", webcam, "vout", opts.assPath));
  } else {
    const finalVideo = opts.assPath ? `${videoFilter},${assFilter(opts.assPath)}` : videoFilter;
    chains.push(`[vc]${finalVideo}[vout]`);
  }

  args.push("-filter_complex", chains.join(";"), "-map", "[vout]");
  if (hasAudio) args.push("-map", "[ac]");
  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "21",
    "-profile:v", "high",
    "-level", "4.1",
    "-pix_fmt", "yuv420p",
    "-r", "30",
  );
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2");
  // Same clean-start treatment as the single cut: constant frame rate, no
  // negative timestamps, index first.
  args.push(
    "-fps_mode", "cfr",
    "-fflags", "+genpts",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
    "-y",
    opts.outPath,
  );
  await ffmpeg(args, opts.timeoutMs ?? 300_000);
}

/**
 * Copies a window of a source without re-encoding. Used to keep the footage a
 * clip was cut from, so a re-cut has something to cut from while the stream is
 * still live and Twitch has published no archive VOD.
 */
export async function cutCopy(
  input: string,
  startSec: number,
  durationSec: number,
  outPath: string,
): Promise<void> {
  await ffmpeg(
    [
      "-hide_banner", "-loglevel", "error",
      "-ss", Math.max(0, startSec).toFixed(3),
      "-t", Math.max(1, durationSec).toFixed(2),
      "-i", input,
      "-map", "0:v:0?", "-map", "0:a:0?",
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      "-y", outPath,
    ],
    120_000,
  );
}

export async function thumbnail(videoPath: string, outPath: string): Promise<void> {
  await ffmpeg([
    "-hide_banner",
    "-loglevel", "error",
    "-ss", "1",
    "-i", videoPath,
    "-frames:v", "1",
    "-vf", "scale=540:-2",
    "-q:v", "3",
    "-y",
    outPath,
  ], 60_000);
}

export function ffprobeDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
    proc.on("error", () => resolve(0));
    proc.on("close", () => resolve(Number.parseFloat(out.trim()) || 0));
  });
}

export async function probeDuration(videoPath: string): Promise<number> {
  const stderr = await ffmpeg(["-hide_banner", "-i", videoPath, "-f", "null", "-"], 60_000).catch(
    (err: Error) => err.message,
  );
  const match = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(stderr);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function dimsFor(aspect: "9:16" | "1:1" | "16:9"): { width: number; height: number } {
  if (aspect === "1:1") return { width: 1080, height: 1080 };
  if (aspect === "16:9") return { width: 1920, height: 1080 };
  return { width: 1080, height: 1920 };
}
