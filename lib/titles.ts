/**
 * Clip titles. The model is told not to reuse recent titles, but a prompt is not
 * a guarantee, so every title is also checked against the ones already stored.
 */
const normalise = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Returns `base` when it is unused, otherwise the first unused variant, then
 * numbered alternatives. Never returns an empty or over-long title.
 */
export function uniqueTitle(base: string, taken: string[], variants: string[] = []): string {
  const clean = (base ?? "").trim().replace(/\s+/g, " ").slice(0, 90) || "Twitch moment";
  const seen = new Set(taken.map(normalise).filter(Boolean));
  if (!seen.has(normalise(clean))) return clean;

  const attempts = [
    ...variants,
    ...Array.from({ length: 9 }, (_, index) => `${clean} (${index + 2})`),
  ];
  for (const raw of attempts) {
    const candidate = String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, 90);
    if (candidate && !seen.has(normalise(candidate))) return candidate;
  }
  return `${clean} (${Date.now().toString(36).slice(-4)})`.slice(0, 90);
}

/**
 * Captions land on the card and get pasted into a post, so two clips sharing
 * one look like a duplicate upload. A caption must also never be its own
 * title; both are checked here against everything already stored.
 */
export function uniqueCaption(
  base: string,
  taken: string[],
  title = "",
  variants: string[] = [],
): string {
  const clean = (base ?? "").trim().replace(/\s+/g, " ").slice(0, 90) || "TWITCH CLIP";
  const seen = new Set([...taken, title].map(normalise).filter(Boolean));
  if (!seen.has(normalise(clean))) return clean;

  const attempts = [
    ...variants,
    ...Array.from({ length: 9 }, (_, index) => `${clean} #${index + 2}`),
  ];
  for (const raw of attempts) {
    const candidate = String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, 90);
    if (candidate && !seen.has(normalise(candidate))) return candidate;
  }
  return `${clean} #${Date.now().toString(36).slice(-4)}`.slice(0, 90);
}

export interface TitleRow {
  id: string;
  title: string | null;
}

/**
 * Keeps the oldest clip's title and renames every later duplicate. Deterministic
 * for a given order, so two concurrent requests make the same changes.
 */
export function uniqueTitleChanges(rows: TitleRow[]): { id: string; title: string }[] {
  const assigned: string[] = [];
  const changes: { id: string; title: string }[] = [];
  for (const row of rows) {
    const base = (row.title ?? "").trim() || "Twitch moment";
    const title = uniqueTitle(base, assigned);
    assigned.push(title);
    if (title !== row.title) changes.push({ id: row.id, title });
  }
  return changes;
}
