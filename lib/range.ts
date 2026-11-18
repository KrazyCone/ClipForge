/**
 * HTTP byte-range handling for the media proxy.
 *
 * `<video>` only plays (and only seeks) through correct partial responses, and
 * every browser asks differently: Chrome starts with `bytes=0-`, Safari asks
 * for explicit chunks like `bytes=0-1048575`, and players probing an index ask
 * for a suffix. All three have to resolve to a real offset and length, and the
 * response has to report that exact length - not the size of the whole file.
 */

/** What the request asked for, before the object size is known. */
export type RequestedRange =
  | { offset: number; length?: number }
  | { suffix: number };

/** A concrete slice of an object. */
export interface ResolvedRange {
  start: number;
  length: number;
}

/** `bytes=0-1023`, `bytes=500-`, `bytes=-500`. Anything else is ignored. */
export function parseRange(header: string | null): RequestedRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, startRaw, endRaw] = match;
  if (startRaw === "" && endRaw === "") return null;

  if (startRaw === "") {
    const suffix = Number(endRaw);
    return suffix > 0 ? { suffix } : null;
  }

  const offset = Number(startRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  if (endRaw === "") return { offset };

  const end = Number(endRaw);
  if (!Number.isSafeInteger(end) || end < offset) return null;
  return { offset, length: end - offset + 1 };
}

/**
 * Clamps a request against the real object size. Returns `null` when the range
 * is already the whole object (so the caller can answer 200), and
 * `"unsatisfiable"` when it starts past the end (416).
 */
export function resolveRange(
  range: RequestedRange,
  size: number,
): ResolvedRange | null | "unsatisfiable" {
  if (size <= 0) return "unsatisfiable";

  if ("suffix" in range) {
    const start = Math.max(0, size - range.suffix);
    return start === 0 ? null : { start, length: size - start };
  }

  const start = range.offset;
  if (start >= size) return "unsatisfiable";
  const length = range.length === undefined ? size - start : Math.min(range.length, size - start);
  if (start === 0 && length >= size) return null;
  return { start, length };
}
