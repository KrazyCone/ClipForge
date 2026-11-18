/** Normalized crop of the streamer's face cam, stored on the clip. */
export interface WebcamBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

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
