import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
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

  // A source can have one stream starting before the other (a live snapshot
  // whose first segment carries audio first is the usual case). Left alone,
  // the clip starts with audio-only time: the player holds the first frame
  // while the audio runs. Trim the leading audio to the first video frame and
  // trim both streams to the same length.
  const durationStr = opts.durationSec.toFixed(3);
  let audioLead = 0;
  if (segments.length <= 1) {
    const starts = await ffprobeStreamStarts(opts.input).catch(() => null);
    if (starts) {
      // Only a real gap, not encoder priming: anything longer than a frame or
      // two means the picture genuinely starts later than the sound.
      audioLead = Math.min(2, Math.max(0, starts.video - starts.audio));
      if (audioLead < 0.08) audioLead = 0;
    }
  }
  const normalisedVideo = `setpts=PTS-STARTPTS,fps=30,trim=duration=${durationStr},setpts=PTS-STARTPTS`;
  const normalisedAudio =
    `asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,` +
    `atrim=start=${audioLead.toFixed(3)},asetpts=PTS-STARTPTS,` +
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
    "-ss", opts.startSec.toFixed(2),
    // Extra read so the leading audio can be dropped without shortening the
    // clip on sources whose video starts late.
    "-t", (opts.durationSec + audioLead + 0.5).toFixed(2),
    "-i", opts.input,
    "-filter_complex", filterComplex,
    "-map", "[v]",
    "-map", "0:a?",
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
 * Face-forward layout: the webcam crop fills a 1080x600 band at the top and the
 * whole gameplay frame sits below it over a blurred fill. The band is sized so
 * the face is clearly bigger than in the full-frame layout without shrinking
 * the gameplay more than necessary; subtitles burn over the gameplay half.
 */
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
    `[wcFaceSrc]crop=iw*${f(box.w)}:ih*${f(box.h)}:iw*${f(box.x)}:ih*${f(box.y)},` +
      `scale=1080:600:force_original_aspect_ratio=increase,crop=1080:600,setsar=1[wcFace]`,
    `[wcGameSrc]scale=1080:1320:force_original_aspect_ratio=decrease[wcGameFit]`,
    `[wcBgSrc]scale=1080:1320:force_original_aspect_ratio=increase,crop=1080:1320,gblur=sigma=26[wcGameBg]`,
    `[wcGameBg][wcGameFit]overlay=(W-w)/2:(H-h)/2[wcGame]`,
    `[wcGame]pad=1080:1920:0:600:black[wcPadded]`,
    `[wcPadded][wcFace]overlay=0:0${assPath ? `,${assFilter(assPath)}` : ""}[${outLabel}]`,
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
  for (const segment of segments) {
    args.push(
      "-ss", Math.max(0, segment.startSec).toFixed(2),
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
  for (let i = 0; i < segments.length; i++) {
    const duration = segments[i].durationSec.toFixed(3);
    chains.push(
      `[${i}:v]setpts=PTS-STARTPTS,fps=30,trim=duration=${duration},setpts=PTS-STARTPTS,` +
        `scale=1920:1080:force_original_aspect_ratio=decrease,` +
        `pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`,
    );
    pairLabels.push(`[v${i}]`);
    if (hasAudio) {
      chains.push(
        `[${i}:a]asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,` +
          `atrim=duration=${duration},asetpts=PTS-STARTPTS,` +
          `aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
      );
      pairLabels.push(`[a${i}]`);
    }
  }
  // One concat for both streams keeps their segment boundaries identical.
  chains.push(
    hasAudio
      ? `${pairLabels.join("")}concat=n=${segments.length}:v=1:a=1[vc][ac]`
      : `${pairLabels.join("")}concat=n=${segments.length}:v=1:a=0[vc]`,
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
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "128k", "-ar", "48000");
  args.push("-movflags", "+faststart", "-y", opts.outPath);
  await ffmpeg(args, opts.timeoutMs ?? 300_000);
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
