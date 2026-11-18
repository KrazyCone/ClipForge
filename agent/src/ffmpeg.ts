import { spawn } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

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

  if (opts.assPath) {
    // Fonts are installed alongside ffmpeg in the workflow image.
    videoFilter += `,ass=${opts.assPath}`;
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
