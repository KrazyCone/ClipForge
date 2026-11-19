/**
 * Ad-break detection.
 *
 * Clips kept landing on Twitch's ad page instead of the stream. Two signals give
 * it away for free: the sampled frames (a vision description of an ad, a
 * countdown, "stream will continue shortly") and the chat, which turns into the
 * word "ad" repeated when a break starts. Neither costs an extra API call.
 */

const AD_FRAME_PATTERNS = [
  /\badvert/i,
  /\bad break\b/i,
  /\bcommercial break\b/i,
  /\btwitch ads?\b/i,
  /stream (?:will|does|should) (?:continue|resume|be back)/i,
  /\bbe right back\b/i,
  /\bright back\b/i,
  /\bsponsor break\b/i,
  /\bpurple screen\b/i,
  /\bad ?block(?:er|ed|ing)?\b/i,
  /\bpre-?roll\b/i,
  /\bmid-?roll\b/i,
  /\bnow playing\b.*\bad\b/i,
];

/** True when a sampled frame's description says it is an ad, not the stream. */
export function looksLikeAdFrame(text: string | null | undefined): boolean {
  const clean = (text ?? "").trim();
  if (!clean) return false;
  return AD_FRAME_PATTERNS.some((pattern) => pattern.test(clean));
}

/** A short message that is nothing but a complaint or note about the ads. */
const AD_CHAT = /^\W*(?:ad|ads|advert|adverts|advertisement|adblock|adblocker|adblocked|commercial|commercials|preroll|midroll)\W*$/i;

/**
 * Share of sampled messages that are purely about the ad break. Chat shouting
 * "ad" in a burst is the clearest evidence that the moment is an ad, even when
 * the frames could not be described.
 */
export function chatAdShare(messages: string[]): number {
  const usable = messages
    .map((m) => m.split(/:\s*/).slice(1).join(": ").trim() || m.trim())
    .filter((m) => m.length > 0 && m.length <= 24);
  if (usable.length < 4) return 0;
  const hits = usable.filter((m) => AD_CHAT.test(m)).length;
  return hits / usable.length;
}

/** An ad break by chat alone: a clear majority of short messages say "ad". */
export function chatLooksLikeAd(messages: string[]): boolean {
  return chatAdShare(messages) >= 0.5;
}
