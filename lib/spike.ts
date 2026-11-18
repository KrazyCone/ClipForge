/**
 * Adaptive chat spike detection.
 *
 * Deliberately dependency-free so the same code runs inside the Next.js API
 * (for ingest-time validation) and inside the always-on collector worker.
 *
 * The core idea: never compare a channel to a global threshold. Build a baseline
 * from that channel's own recent history using median + MAD (robust to the very
 * spikes we are hunting), then score a burst on how far it departs from that
 * baseline, how much it accelerates, and what *kind* of messages it contains.
 */

export interface ChatMessage {
  /** unix seconds (may be fractional) */
  t: number;
  text: string;
  user: string;
  /** emotes already extracted by the collector */
  emotes?: string[];
}

export interface SpikeConfig {
  /** minimum intensity (0-100) to emit an event */
  minIntensity: number;
  /** minimum robust z-score, keeps tiny channels from firing on noise */
  minZ: number;
  /** minimum burst/baseline ratio */
  minRatio: number;
  /** absolute floor: never fire on fewer than this many messages in the burst window */
  minMessages: number;
  /** seconds of history used for the baseline */
  baselineSeconds: number;
  /** length of the "current activity" window, seconds */
  burstSeconds: number;
  /** ignore new events within this many seconds of the previous one */
  cooldownSeconds: number;
}

/** Map the 0-100 sensitivity slider onto concrete detector thresholds. */
export function configFromSensitivity(sensitivity: number): SpikeConfig {
  const s = Math.min(100, Math.max(0, sensitivity));
  return {
    ...DEFAULT_SPIKE_CONFIG,
    minIntensity: Math.min(82, Math.max(30, 88 - s * 0.55)),
    minZ: Math.min(4.2, Math.max(1.7, 4.4 - s * 0.028)),
    minRatio: Math.min(3.4, Math.max(1.45, 3.4 - s * 0.022)),
  };
}

export const DEFAULT_SPIKE_CONFIG: SpikeConfig = {
  minIntensity: 55,
  minZ: 2.5,
  minRatio: 2.0,
  minMessages: 8,
  baselineSeconds: 60,
  burstSeconds: 8,
  cooldownSeconds: 90,
};

export interface SpikeFeatures {
  /** messages per second during the burst */
  peakRate: number;
  /** messages per second of the preceding baseline */
  baselineRate: number;
  zScore: number;
  ratio: number;
  /** unique chatters in the burst */
  uniqueChatters: number;
  /** unique chatters per message, 0..1 - low means a few people spamming */
  chatterDiversity: number;
  emoteRatio: number;
  repeatRatio: number;
  laughRatio: number;
  capsRatio: number;
  /** variance/mean of per-second counts: >1 means clustered, not steady */
  burstiness: number;
  /** peakRate / previous 3s rate, how abruptly it started */
  acceleration: number;
  messageCount: number;
  burstStart: number;
  burstEnd: number;
}

export interface SpikeCandidate {
  intensity: number;
  features: SpikeFeatures;
  samples: string[];
  /** unix seconds of the most representative burst second */
  ts: number;
}

const LAUGH_TOKENS = [
  "lol", "lmao", "lmfao", "rofl", "kek", "kekw", "omegalul", "xd", "haha",
  "hahaha", "jaja", "lul", "lulw", "💀", "😭", "🤣", "😂", "dead", "dying",
];
const HYPE_TOKENS = [
  "pog", "poggers", "pogchamp", "letsgo", "lets", "gooo", "clutch", "insane",
  "crazy", "wtf", "wow", "no", "way", "clip", "clipit", "gg", "ez", "holy",
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Normalised message fingerprint: collapse repeats like "LETS GO LETS GO". */
export function normaliseMessage(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(\w+)(\s+\1\b)+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function isLaugh(text: string): boolean {
  const t = text.toLowerCase();
  return LAUGH_TOKENS.some((k) => t.includes(k));
}

export function isHype(text: string): boolean {
  const t = text.toLowerCase();
  return HYPE_TOKENS.some((k) => t.split(/\s+/).includes(k) || t.includes(k));
}

function tokenSet(text: string): Set<string> {
  return new Set(normaliseMessage(text).split(" ").filter((w) => w.length > 2));
}

/** Jaccard similarity between two messages, used for "chat is saying the same thing". */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Build per-second message counts for [from, to).
 * Index 0 corresponds to second `from`.
 */
export function perSecondSeries(messages: ChatMessage[], from: number, to: number): number[] {
  const len = Math.max(1, Math.ceil(to - from));
  const series = new Array(len).fill(0);
  for (const m of messages) {
    const i = Math.floor(m.t - from);
    if (i >= 0 && i < len) series[i] += 1;
  }
  return series;
}

interface WindowStats {
  z: number;
  baseline: number;
  peak: number;
  peakIndex: number;
  burstiness: number;
  acceleration: number;
}

function analyse(
  series: number[],
  baselineSeconds: number,
  burstSeconds: number,
): WindowStats {
  const n = series.length;
  const burstStart = Math.max(0, n - burstSeconds);
  const burst = series.slice(burstStart);
  const histStart = Math.max(0, burstStart - baselineSeconds);
  const history = series.slice(histStart, burstStart);

  const baseline = median(history);
  const deviations = history.map((v) => Math.abs(v - baseline));
  // 1.4826 * MAD approximates sigma for normal data. Counts are never quieter
  // than Poisson noise, so sqrt(baseline) is the floor: without it a perfectly
  // steady channel with MAD 0 produces an astronomically large z-score and a
  // 30% bump looks like a once-in-a-lifetime event.
  const poissonSigma = Math.sqrt(Math.max(baseline, 0.25));
  const sigma = Math.max(1.4826 * median(deviations), poissonSigma, 0.45);

  const peak = burst.length ? Math.max(...burst) : 0;
  const peakIndex = burstStart + (burst.length ? burst.indexOf(peak) : 0);
  const mean = burst.length ? burst.reduce((a, b) => a + b, 0) / burst.length : 0;
  const variance = burst.length
    ? burst.reduce((a, b) => a + (b - mean) ** 2, 0) / burst.length
    : 0;

  const z = (mean - baseline) / sigma;
  const burstiness = mean > 0 ? variance / mean : 0;
  const prior = series.slice(Math.max(0, burstStart - 3), burstStart);
  const priorRate = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
  const acceleration = mean / Math.max(priorRate, 0.5);

  return { z, baseline, peak, peakIndex, burstiness, acceleration };
}

/**
 * Score the most recent window of chat. Returns null when the window is not a
 * spike. `now` is unix seconds; only messages within
 * baselineSeconds + burstSeconds of `now` are considered.
 */
export function detectSpike(
  messages: ChatMessage[],
  now: number,
  config: Partial<SpikeConfig> = {},
): SpikeCandidate | null {
  const cfg = { ...DEFAULT_SPIKE_CONFIG, ...config };
  const from = now - cfg.baselineSeconds - cfg.burstSeconds;
  const recent = messages.filter((m) => m.t >= from && m.t <= now);
  if (recent.length === 0) return null;

  const series = perSecondSeries(recent, from, now + 1);
  const stats = analyse(series, cfg.baselineSeconds, cfg.burstSeconds);
  if (stats.peak < 1) return null;

  const burstStart = Math.max(from, now - cfg.burstSeconds);
  const burstMessages = recent.filter((m) => m.t >= burstStart);

  // Re-centre on the densest second so the clip is cut around the actual action.
  const peakSecond = from + stats.peakIndex;
  const focus = recent.filter((m) => m.t >= peakSecond - 2 && m.t <= peakSecond + 3);
  const counted = focus.length >= 3 ? focus : burstMessages;

  const uniq = new Set(counted.map((m) => m.user));
  const chatterDiversity = counted.length ? uniq.size / counted.length : 0;

  const emoteCount = counted.filter((m) => (m.emotes?.length ?? 0) > 0).length;
  const emoteRatio = counted.length ? emoteCount / counted.length : 0;

  const laughCount = counted.filter((m) => isLaugh(m.text)).length;
  const laughRatio = counted.length ? laughCount / counted.length : 0;

  const hypeCount = counted.filter((m) => isHype(m.text)).length;

  const letters = counted.map((m) => m.text.replace(/[^a-zA-Z]/g, ""));
  const lettersTotal = letters.reduce((a, b) => a + b.length, 0);
  const upperTotal = letters.reduce(
    (a, b) => a + b.replace(/[^A-Z]/g, "").length,
    0,
  );
  const capsRatio = lettersTotal ? upperTotal / lettersTotal : 0;

  // Repetition: share of messages that closely echo an earlier message.
  const sets = counted.map((m) => tokenSet(m.text));
  let repeats = 0;
  for (let i = 1; i < sets.length; i++) {
    for (let j = Math.max(0, i - 12); j < i; j++) {
      if (similarity(sets[i], sets[j]) >= 0.67) {
        repeats++;
        break;
      }
    }
  }
  const repeatRatio = counted.length ? repeats / counted.length : 0;

  const peakRate = stats.peak;
  const ratio = (peakRate + 1) / (stats.baseline + 1);

  // Busy chats cannot double: at 20-40 messages/s a real moment usually reads
  // as a 1.6-2x burst for a few seconds. Scoring every channel against a quiet
  // channel's 2x+ multiple is why a monitoring run could sit on five live
  // channels for an hour and emit nothing. The z-test still has to agree, so a
  // 20 -> 30/s wobble is not enough on its own.
  const busy = stats.baseline >= 8;
  const minRatio = busy ? Math.min(cfg.minRatio, 1.55) : cfg.minRatio;
  const minZ = busy ? Math.min(cfg.minZ, 1.9) : cfg.minZ;
  const minIntensity = busy ? Math.min(cfg.minIntensity, 52) : cfg.minIntensity;

  const zScore = clamp((stats.z - 2) / 12, 0, 1);
  const ratioScore = clamp(Math.log2(ratio) / 3.2, 0, 1);
  // Volume matters but is capped: a 40 msg/s burst in a huge channel should not
  // drown out a 9 msg/s burst in a quiet one.
  const volumeScore = clamp(Math.log2(peakRate + 1) / 5, 0, 1);
  const emoteScore = clamp(emoteRatio / 0.6, 0, 1);
  const laughScore = clamp(laughRatio / 0.55, 0, 1);
  const diversityScore = 1 - clamp(Math.abs(chatterDiversity - 0.65) / 0.65, 0, 1);
  const repeatScore = clamp(repeatRatio / 0.8, 0, 1);
  const hypeScore = clamp(hypeCount / Math.max(counted.length, 1) / 0.5, 0, 1);
  const burstScore = clamp(Math.log2(stats.burstiness + 1) / 3, 0, 1);

  let intensity =
    100 *
    (0.26 * zScore +
      0.20 * ratioScore +
      0.11 * volumeScore +
      0.10 * emoteScore +
      0.10 * laughScore +
      0.07 * diversityScore +
      0.06 * repeatScore +
      0.05 * hypeScore +
      0.05 * burstScore);
  // Reward a genuinely abrupt onset - that is the shape of a reaction moment.
  intensity *= 1 + 0.12 * clamp(Math.log2(stats.acceleration) / 2, 0, 1);
  intensity = clamp(intensity, 0, 100);

  // Both tests are required: z proves the burst is statistically unusual for
  // this channel, ratio proves it is a real proportional jump (a 30% bump in a
  // 90 msg/s channel is not a moment). Either one alone produces false clips.
  const fires =
    counted.length >= cfg.minMessages &&
    intensity >= minIntensity &&
    stats.z >= minZ &&
    ratio >= minRatio;

  if (!fires) return null;

  const features: SpikeFeatures = {
    peakRate,
    baselineRate: stats.baseline,
    zScore: Number(stats.z.toFixed(2)),
    ratio: Number(ratio.toFixed(2)),
    uniqueChatters: uniq.size,
    chatterDiversity: Number(chatterDiversity.toFixed(3)),
    emoteRatio: Number(emoteRatio.toFixed(3)),
    repeatRatio: Number(repeatRatio.toFixed(3)),
    laughRatio: Number(laughRatio.toFixed(3)),
    capsRatio: Number(capsRatio.toFixed(3)),
    burstiness: Number(stats.burstiness.toFixed(2)),
    acceleration: Number(stats.acceleration.toFixed(2)),
    messageCount: counted.length,
    burstStart: peakSecond - 2,
    burstEnd: peakSecond + 3,
  };

  const samples = [...counted]
    .sort((a, b) => (b.emotes?.length ?? 0) - (a.emotes?.length ?? 0))
    .slice(0, 30)
    .map((m) => `${m.user}: ${m.text}`);

  return {
    intensity: Number(intensity.toFixed(1)),
    features,
    samples,
    ts: peakSecond,
  };
}

/**
 * Should a new spike be folded into an existing one? Prevents two clips for the
 * same moment when chat stays hot for a while.
 */
export function shouldMerge(
  candidateTs: number,
  existingTs: number,
  candidateIntensity: number,
  existingIntensity: number,
  cooldownSeconds: number,
): boolean {
  const gap = Math.abs(candidateTs - existingTs);
  if (gap > cooldownSeconds) return false;
  // A materially bigger burst is a new moment even inside the cooldown.
  return candidateIntensity <= existingIntensity * 1.35;
}

/** Deterministic 0-100 quality heuristic used when no model is configured. */
export function heuristicQuality(f: SpikeFeatures): {
  score: number;
  category: string;
  reasoning: string;
} {
  const signal =
    0.35 * clamp(f.emoteRatio / 0.6, 0, 1) +
    0.3 * clamp(f.laughRatio / 0.55, 0, 1) +
    0.2 * clamp(Math.log2(f.ratio) / 3, 0, 1) +
    0.15 * clamp(f.repeatRatio / 0.7, 0, 1);
  const score = Math.round(clamp(38 + signal * 55, 0, 96));
  let category = "exciting";
  if (f.laughRatio >= 0.28 || f.emoteRatio >= 0.5) category = "funny";
  else if (f.acceleration >= 4) category = "surprising";
  else if (f.repeatRatio >= 0.5) category = "dramatic";
  return {
    score,
    category,
    reasoning:
      `Chat moved from ${f.baselineRate.toFixed(1)}/s to ${f.peakRate}/s ` +
      `(${f.ratio}x, z=${f.zScore}) with ${f.uniqueChatters} unique chatters, ` +
      `${Math.round(f.emoteRatio * 100)}% emote messages and ` +
      `${Math.round(f.laughRatio * 100)}% laughter tokens.`,
  };
}
