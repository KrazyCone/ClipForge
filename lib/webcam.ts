/**
 * The vision model is good at "which part of the frame is the face cam", not at
 * pixel-perfect boxes, so it answers with a 3x3 region and a rough size. That
 * maps onto a normalized box the renderer can crop safely.
 */
export interface WebcamHint {
  visible: boolean;
  region: string;
  size: string;
}

export interface WebcamBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Anchor of the box within the frame, 0 = left/top, 1 = right/bottom. */
const ANCHORS: Record<string, [number, number]> = {
  "top-left": [0, 0],
  "top-center": [0.5, 0],
  "top-right": [1, 0],
  "mid-left": [0, 0.5],
  "mid-center": [0.5, 0.5],
  "mid-right": [1, 0.5],
  "bottom-left": [0, 1],
  "bottom-center": [0.5, 1],
  "bottom-right": [1, 1],
};

const WIDTHS: Record<string, number> = {
  small: 0.2,
  medium: 0.28,
  large: 0.36,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 10_000) / 10_000;

/** Validates whatever the model returned into the shape the renderer expects. */
export function normaliseHint(raw: unknown): WebcamHint | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const visible = value.webcam ?? value.visible;
  if (visible !== true) return null;
  const region = String(value.region ?? "").toLowerCase();
  if (!(region in ANCHORS)) return null;
  const size = String(value.size ?? "medium").toLowerCase();
  return { visible: true, region, size: size in WIDTHS ? size : "medium" };
}

/** Turns a region/size hint into a normalized crop box, always inside the frame. */
export function boxFromHint(hint: WebcamHint | null): WebcamBox | null {
  if (!hint?.visible) return null;
  const anchor = ANCHORS[hint.region];
  if (!anchor) return null;

  const w = WIDTHS[hint.size] ?? WIDTHS.medium;
  // A face cam is roughly 4:3. Normalized height therefore needs the 16:9
  // frame aspect folded in, or the crop comes out as a letterbox strip.
  const h = Math.min(0.9, w * (16 / 9) * 0.75);
  const x = clamp(anchor[0] * (1 - w), 0, 1 - w);
  const y = clamp(anchor[1] * (1 - h), 0, 1 - h);
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

/** Reads the box stored on a clip (`{ box, region, size }` or a bare box). */
export function parseWebcamBox(json: string | null | undefined): WebcamBox | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    const raw = (value.box ?? value) as Record<string, unknown>;
    const box = {
      x: Number(raw.x),
      y: Number(raw.y),
      w: Number(raw.w),
      h: Number(raw.h),
    };
    if (!Object.values(box).every((n) => Number.isFinite(n))) return null;
    if (box.w <= 0.05 || box.h <= 0.05 || box.w > 0.9 || box.h > 0.95) return null;
    if (box.x < 0 || box.y < 0 || box.x + box.w > 1.001 || box.y + box.h > 1.001) return null;
    return box;
  } catch {
    return null;
  }
}

export function storedWebcam(hint: WebcamHint, box: WebcamBox): string {
  return JSON.stringify({ visible: true, region: hint.region, size: hint.size, box });
}
