/**
 * Poll and command chatter looks like a spike: everyone types at once. But the
 * messages are short answers ("1", "A", "yes", "!vote") rather than reactions.
 * This distinguishes the two from the sampled messages the collector already
 * stores, so a poll is not clipped unless something actually happens on stream.
 */
export interface PollHint {
  likely: boolean;
  /** share of sampled messages that were the most common answer, 0..1 */
  share: number;
  top: string | null;
  distinct: number;
  reason: string;
}

/** Words that are reactions, not votes, even when chat repeats them. */
const REACTIONS = new Set([
  "kekw", "lul", "lulw", "omegalul", "lmao", "lol", "lmfao", "haha", "hahaha",
  "xd", "pog", "pogchamp", "w", "wwww", "sheesh", "bruh", "omg", "no way",
  "what", "gg", "ez", "dead", "dying", "clipped", "clip it",
]);

/** Answers that only make sense as a poll or command response. */
const OPTION = /^(?:[1-9]|[a-d]|yes|no|y|n|true|false|maybe|option ?[1-9]|vote|!vote|poll|!poll|\?)$/;

const clean = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}!?]+/gu, " ")
    .trim();

export function pollSignals(samples: string[]): PollHint {
  // Punctuation-only messages ("!!!") are noise, not an answer.
  const messages = samples.map(clean).filter((m) => /[\p{L}\p{N}]/u.test(m));
  const total = messages.length;
  if (total < 8) {
    return { likely: false, share: 0, top: null, distinct: 0, reason: "not enough sampled messages" };
  }

  const counts = new Map<string, number>();
  for (const message of messages) counts.set(message, (counts.get(message) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [top, count] = sorted[0];
  const share = count / total;
  const distinct = counts.size;
  const words = top.split(/\s+/);

  const optionAnswer = OPTION.test(top);
  // "LMAO NO WAY" repeated is a reaction, not a copy-paste vote.
  const reactionPhrase = words.some((word) => REACTIONS.has(word));
  // A short phrase repeated by most of chat can also be a copy-paste vote.
  const repeatedPhrase =
    share >= 0.55 &&
    distinct <= Math.max(3, Math.ceil(total * 0.2)) &&
    words.length <= 3 &&
    !reactionPhrase;

  const likely = optionAnswer ? share >= 0.45 && distinct <= 4 : repeatedPhrase;
  return {
    likely,
    share: Math.round(share * 100) / 100,
    top,
    distinct,
    reason: likely
      ? `${Math.round(share * 100)}% of sampled messages said "${top}" across ${distinct} distinct messages`
      : "chat is varied enough to be a reaction, not a vote",
  };
}
