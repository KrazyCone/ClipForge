/** The operator's standing direction for every clip, kept as prompt text. */
export const MAX_DIRECTION_CHARS = 1200;

export function cleanDirection(direction: string | null | undefined): string {
  return (direction ?? "").trim().slice(0, MAX_DIRECTION_CHARS);
}

/**
 * Appends the direction to the analysis rules. It may tighten the rules but
 * never replaces the JSON contract or the ban on inventing events.
 */
export function withDirection(basePrompt: string, direction: string | null | undefined): string {
  const clean = cleanDirection(direction);
  if (!clean) return basePrompt;
  return (
    `${basePrompt}\n- Operator direction for every clip. Follow it for which segments you pick, ` +
    `the title, the caption and the hashtags. It can tighten the rules above but never overrides ` +
    `the JSON shape, the offsets, or the ban on inventing events:\n${clean}`
  );
}

/** The same direction, phrased for single-caption regeneration. */
export function captionDirectionSuffix(direction: string | null | undefined): string {
  const clean = cleanDirection(direction);
  return clean
    ? ` The channel operator's standing direction for every clip: ${clean}`
    : "";
}
