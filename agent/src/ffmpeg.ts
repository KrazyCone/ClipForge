import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

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
}

/**
 * Vertical render. `blur` keeps the whole frame visible over a blurred fill so
 * nothing is cropped away; `center`/`left`/`right` crop hard to the frame.
 */
export async function renderClip(opts: RenderOptions): Promise<void> {
  const { width, height } = dimsFor(opts.aspect);

  let videoFilter: string;
  if (opts.aspect === "16:9") {
    videoFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  } else if (opts.cropMode === "blur") {
    videoFilter =
      `split=2[bg][fg];` +
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=26[bgb];` +
      `[fg]scale=${width}:-2:force_original_aspect_ratio=decrease[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2`;
  } else {
    // Crop toward a third of the frame: left keeps a webcam column, right keeps
    // the right-hand HUD, center is the default.
    const anchor = opts.cropX === "left" ? 0 : opts.cropX === "right" ? 1 : 0.5;
    videoFilter =
      `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height}:(iw-${width})*${anchor}:(ih-${height})/2`;
  }

  const segments = (opts.segments ?? []).filter((s) => s.durationSec >= 1);

  if (segments.length > 1) {
    await renderJoined(opts, segments, videoFilter);
    return;
  }

  if (opts.assPath) {
    videoFilter += `,${assFilter(opts.assPath)}`;
  }

  await ffmpeg([
    "-hide_banner",
    "-loglevel", "error",
    "-ss", opts.startSec.toFixed(2),
    "-t", opts.durationSec.toFixed(2),
    "-i", opts.input,
    "-filter_complex", `[0:v]${videoFilter}[v]`,
    "-map", "[v]",
    "-map", "0:a?",
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
  ], 240_000);
}

/**
 * Joins several cuts of one source into a single video. Each cut is its own
 * input so a long archive VOD is only decoded at the beats, not end to end.
 * The vertical/blur treatment is applied once after the join, and the subtitle
 * file covers the joined timeline.
 */
async function renderJoined(
  opts: RenderOptions,
  segments: { startSec: number; durationSec: number }[],
  videoFilter: string,
): Promise<void> {
  const hasAudio = await ffprobeHasAudio(opts.input);
  const args = ["-hide_banner", "-loglevel", "error"];
  for (const segment of segments) {
    args.push(
      "-ss", Math.max(0, segment.startSec).toFixed(2),
      "-t", segment.durationSec.toFixed(2),
      "-i", opts.input,
    );
  }

  // Every cut must share dimensions, sample aspect ratio and frame rate before
  // concat accepts them. 1080p keeps the 9:16 foreground sharp.
  const normalise =
    "scale=1920:1080:force_original_aspect_ratio=decrease," +
    "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,setpts=PTS-STARTPTS";
  const chains: string[] = [];
  const videoLabels: string[] = [];
  const audioLabels: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    chains.push(`[${i}:v]${normalise}[v${i}]`);
    videoLabels.push(`[v${i}]`);
    if (hasAudio) {
      chains.push(
        `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`,
      );
      audioLabels.push(`[a${i}]`);
    }
  }
  chains.push(
    `${videoLabels.join("")}concat=n=${segments.length}:v=1:a=0[vc]`,
  );
  if (hasAudio) {
    chains.push(`${audioLabels.join("")}concat=n=${segments.length}:v=0:a=1[ac]`);
  }

  const finalVideo = opts.assPath ? `${videoFilter},${assFilter(opts.assPath)}` : videoFilter;
  chains.push(`[vc]${finalVideo}[vout]`);

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
  await ffmpeg(args, 300_000);
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
