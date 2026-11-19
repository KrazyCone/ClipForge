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

/**
 * Centre of each region cell. Cropping around the cell centre rather than the
 * frame corner keeps a webcam that sits a little way in from the edge inside
 * the crop instead of filling it with the edge of the game.
 */
const CELLS: Record<string, [number, number]> = {
  "top-left": [1 / 6, 1 / 6],
  "top-center": [0.5, 1 / 6],
  "top-right": [5 / 6, 1 / 6],
  "mid-left": [1 / 6, 0.5],
  "mid-center": [0.5, 0.5],
  "mid-right": [5 / 6, 0.5],
  "bottom-left": [1 / 6, 5 / 6],
  "bottom-center": [0.5, 5 / 6],
  "bottom-right": [5 / 6, 5 / 6],
};

/**
 * Every placement the UI offers, in reading order. Plenty of streamers put the
 * cam halfway up the left or right edge rather than in a corner, so the middle
 * row is a first-class choice, not something only the model can guess.
 */
export const WEBCAM_REGION_OPTIONS: { value: string; label: string }[] = [
  { value: "top-left", label: "Top left" },
  { value: "top-center", label: "Top middle" },
  { value: "top-right", label: "Top right" },
  { value: "mid-left", label: "Middle left" },
  { value: "mid-center", label: "Middle" },
  { value: "mid-right", label: "Middle right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-center", label: "Bottom middle" },
  { value: "bottom-right", label: "Bottom right" },
];

/**
 * The model, and people, describe the same cell in several ways ("middle left",
 * "left-middle", "centre left", "left side"). Every spelling collapses onto the
 * nine canonical regions instead of throwing an otherwise usable detection away.
 */
const REGION_ALIASES: Record<string, string> = {
  "top left": "top-left",
  "upper left": "top-left",
  "top middle": "top-center",
  "top center": "top-center",
  "top centre": "top-center",
  "upper middle": "top-center",
  "upper center": "top-center",
  "upper centre": "top-center",
  "top right": "top-right",
  "upper right": "top-right",
  "middle left": "mid-left",
  "mid left": "mid-left",
  "left middle": "mid-left",
  "left mid": "mid-left",
  "center left": "mid-left",
  "centre left": "mid-left",
  "left center": "mid-left",
  "left centre": "mid-left",
  "left side": "mid-left",
  left: "mid-left",
  "middle center": "mid-center",
  "middle centre": "mid-center",
  "dead center": "mid-center",
  "dead centre": "mid-center",
  middle: "mid-center",
  center: "mid-center",
  centre: "mid-center",
  "middle right": "mid-right",
  "mid right": "mid-right",
  "right middle": "mid-right",
  "right mid": "mid-right",
  "center right": "mid-right",
  "centre right": "mid-right",
  "right center": "mid-right",
  "right centre": "mid-right",
  "right side": "mid-right",
  right: "mid-right",
  "bottom left": "bottom-left",
  "lower left": "bottom-left",
  "bottom middle": "bottom-center",
  "bottom center": "bottom-center",
  "bottom centre": "bottom-center",
  "lower middle": "bottom-center",
  "lower center": "bottom-center",
  "lower centre": "bottom-center",
  "bottom right": "bottom-right",
  "lower right": "bottom-right",
};

/** Coerces any spelling of a placement onto one of the nine canonical cells. */
export function canonicalRegion(raw: unknown): string | null {
  const text = String(raw ?? "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\bcorner\b/gi, "")
    .replace(/\bof the (screen|frame)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (text in CELLS) return text;
  return REGION_ALIASES[text] ?? null;
}

const WIDTHS: Record<string, number> = {
  small: 0.2,
  medium: 0.26,
  large: 0.32,
};

/** Regions the renderer accepts, for a manual override in the UI. */
export const WEBCAM_REGIONS = Object.keys(CELLS);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 10_000) / 10_000;

/** Validates whatever the model returned into the shape the renderer expects. */
export function normaliseHint(raw: unknown): WebcamHint | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const visible = value.webcam ?? value.visible ?? value.has_webcam ?? value.facecam;
  // Models answer booleans as strings often enough that a bare `!== true` used
  // to discard real detections.
  if (visible !== true && visible !== "true" && visible !== "yes") return null;
  const region = canonicalRegion(value.region ?? value.position ?? value.corner);
  if (!region) return null;
  // A confident-sounding guess is not a detection; below 55 we keep the normal
  // layout rather than crop a random corner.
  const confidence = Number(value.confidence);
  if (Number.isFinite(confidence) && confidence < 55) return null;
  const size = String(value.size ?? "medium").toLowerCase();
  return { visible: true, region, size: size in WIDTHS ? size : "medium" };
}

/** Turns a region/size hint into a normalized crop box, always inside the frame. */
export function boxFromHint(hint: WebcamHint | null): WebcamBox | null {
  if (!hint?.visible) return null;
  const centre = CELLS[hint.region];
  if (!centre) return null;

  const w = WIDTHS[hint.size] ?? WIDTHS.medium;
  // A face cam is roughly 4:3. Normalized height therefore needs the 16:9
  // frame aspect folded in, or the crop comes out as a letterbox strip.
  const h = Math.min(0.9, w * (16 / 9) * 0.75);
  const x = clamp(centre[0] - w / 2, 0, 1 - w);
  const y = clamp(centre[1] - h / 2, 0, 1 - h);
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

/**
 * Vision models do not always answer in JSON. When the reply is prose, recover
 * the same region/size answer instead of discarding a usable detection.
 */
export function hintFromText(text: string): WebcamHint | null {
  const lower = text.toLowerCase();
  if (!/(webcam|face \s*cam|facecam|camera)/.test(lower)) return null;
  if (/(no webcam|not visible|no face|isn't visible|is not visible)/.test(lower)) return null;

  const vertical = /\b(top|upper)\b/.test(lower)
    ? "top"
    : /\b(mid|middle|center|centre)\b/.test(lower)
      ? "middle"
      : /\b(bottom|lower)\b/.test(lower)
        ? "bottom"
        : null;
  const horizontal = /\bleft\b/.test(lower)
    ? "left"
    : /\bright\b/.test(lower)
      ? "right"
      : /\b(center|centre|middle)\b/.test(lower)
        ? "center"
        : null;
  // "on the left" with no height named is the common half-left, half-middle
  // placement: treat it as the middle row rather than giving up.
  const region = canonicalRegion(
    vertical && horizontal ? `${vertical} ${horizontal}` : (horizontal ?? ""),
  );
  if (!region) return null;

  const size = /\b(large|big|huge)\b/.test(lower)
    ? "large"
    : /\b(small|tiny|little)\b/.test(lower)
      ? "small"
      : "medium";
  return normaliseHint({ webcam: true, region, size });
}

export function storedWebcam(hint: WebcamHint, box: WebcamBox): string {
  return JSON.stringify({ visible: true, region: hint.region, size: hint.size, box });
}
