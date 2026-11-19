/**
 * Moment analysis + copywriting.
 *
 * Two providers, both free:
 *  1. `workers-ai` - Cloudflare Workers AI REST, which has a free daily neuron
 *     allowance. Used for vision, speech-to-text and text when the operator has
 *     supplied an account id + API token.
 *  2. `heuristic` - fully local, deterministic scoring from the chat-signal
 *     features. No network, no key, no cost. Always available.
 *
 * The provider actually used is recorded on every clip so the dashboard never
 * implies a model analysed something it did not.
 */
import type { Env } from "./db";
import type { SpikeFeatures } from "./spike";
import { heuristicQuality } from "./spike";
import { captionDirectionSuffix, withDirection } from "./direction";
import { hintFromText, normaliseHint } from "./webcam";
import type { WebcamHint } from "./webcam";

export interface MomentInput {
  channelName: string;
  gameName: string | null;
  streamTitle: string | null;
  ts: number;
  features: SpikeFeatures;
  messages: string[];
  /** readable summary of sampled frames, when visual analysis ran */
  visualNotes?: string[];
  /** speech transcript around the moment, when STT ran */
  transcript?: string;
  /** start of the analysed footage, in seconds relative to the spike peak */
  windowStartSec?: number;
  /** loudness in dBFS per bucket, relative to the start of the analysed window */
  loudness?: number[];
  loudnessBucketSec?: number;
  /** Whisper segments, relative to the start of the analysed window */
  transcriptSegments?: SpokenSegment[];
  /** ceiling for the assembled multi-cut clip */
  maxClipSec?: number;
  /** the operator's standing direction for every clip (picks, title, caption) */
  direction?: string;
  /** chat looks like a poll or command vote, not a reaction */
  pollHint?: string;
  /** the operator asked for the setup around the moment, not only the payoff */
  contextHint?: boolean;
  /** titles already used by other clips; the new one must differ */
  avoidTitles?: string[];
  /** prior assessment summary, used when regenerating copy */
  summary?: string;
}

export interface SpokenSegment {
  startSec: number;
  endSec: number;
  text: string;
}

/** One cut of the moment, relative to the spike peak. */
export interface MomentBeat {
  startSec: number;
  endSec: number;
  score: number;
}

/** A subtitle card already placed on the assembled clip's timeline. */
export interface TimedCaption {
  startSec: number;
  endSec: number;
  text: string;
}

export interface MomentAnalysis {
  summary: string;
  whyChatReacted: string;
  interesting: boolean;
  category: "funny" | "exciting" | "surprising" | "dramatic" | "boring";
  qualityScore: number;
  funniness: number;
  beginsAtSec: number;
  endsAtSec: number;
  /** cuts chosen for the assembled clip, relative to the spike peak */
  beats: MomentBeat[];
  /** centre of the loudest reaction, or the spike when audio has no clear peak */
  anchorSec: number;
  /** transcript segments the model judged funniest, best first */
  funnySegmentIndices: number[];
  title: string;
  caption: string;
  hashtags: string[];
  provider: "workers-ai" | "heuristic";
  model: string;
}

/** Text model used for assessment and captions. The non-`-fast` variant was
 * deprecated on 2026-05-30, so this is the supported replacement. */
export const DEFAULT_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function aiConfigured(e: Env): boolean {
  return Boolean(e.CF_ACCOUNT_ID && e.CF_AI_TOKEN);
}

async function runModel(e: Env, model: string, body: unknown): Promise<unknown> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${e.CF_ACCOUNT_ID}/ai/run/${model}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${e.CF_AI_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`Workers AI ${model} failed (${res.status}): ${(await res.text()).slice(0, 240)}`);
  }
  return (await res.json()) as unknown;
}

/** Some Whisper responses only carry WebVTT; recover segment timings from it. */
function parseVtt(vtt: string): SpokenSegment[] {
  const toSeconds = (value: string): number => {
    const [h, m, s] = value.split(":");
    return Number(h) * 3600 + Number(m) * 60 + Number(String(s).replace(",", "."));
  };
  const out: SpokenSegment[] = [];
  for (const block of vtt.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timing = lines.find((line) => line.includes("-->") && line.includes(":"));
    if (!timing) continue;
    const [from, to] = timing.split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const text = lines
      .filter((line) => !line.includes("-->") && !/^\d+$/.test(line) && line !== "WEBVTT")
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!text) continue;
    const startSec = toSeconds(from);
    const endSec = toSeconds(to);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) continue;
    out.push({ startSec, endSec, text });
  }
  return out;
}

/** Speech-to-text via Workers AI Whisper. Returns "" when unavailable. */
export async function transcribe(
  e: Env,
  audioBase64: string,
): Promise<{ text: string; segments: SpokenSegment[]; provider: string; error?: string } | null> {
  if (!aiConfigured(e)) return null;
  const model = e.STT_MODEL || "@cf/openai/whisper-large-v3-turbo";
  try {
    // The REST endpoint's input schema takes base64 audio. Sending a JSON array
    // of raw bytes instead made every transcription fail, which is why clips
    // only ever got the caption card: there was never a transcript to burn.
    const json = (await runModel(e, model, { audio: audioBase64 })) as {
      result?: {
        text?: string;
        segments?: { start?: number; end?: number; text?: string }[];
        vtt?: string;
      };
    };
    const parsedSegments = Array.isArray(json.result?.segments)
      ? json.result.segments
          .map((s) => ({
            startSec: Number(s.start),
            endSec: Number(s.end),
            text: String(s.text ?? "").trim(),
          }))
          .filter(
            (s) => s.text && Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec,
          )
      : [];
    const segments =
      parsedSegments.length || typeof json.result?.vtt !== "string"
        ? parsedSegments
        : parseVtt(json.result.vtt);
    return { text: (json.result?.text ?? "").trim(), segments, provider: model };
  } catch (err) {
    // A silent failure here means a clip with no spoken subtitles and no
    // explanation; the caller records this on the spike.
    return { text: "", segments: [], provider: model, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Finds the streamer's face cam in one frame. The model answers with a coarse
 * region and size rather than pixels: that is what it is reliable at, and it is
 * enough to crop and enlarge the face. Returns null when AI is off or unsure.
 */
export async function detectWebcam(
  e: Env,
  jpegBase64: string,
  context: string,
): Promise<WebcamHint | null> {
  if (!aiConfigured(e)) return null;
  const model = e.VISION_MODEL || "@cf/meta/llama-3.2-11b-vision-instruct";
  try {
    const json = (await runModel(e, model, {
      prompt:
        "You inspect one frame of a Twitch stream. Find the streamer's webcam overlay: a separate rectangle showing a real person's face, usually in one corner and often with a border. " +
        "It is NOT the game, a minimap, a kill feed, a scoreboard, a HUD, an in-game character, a portrait or a logo. If the only face is part of the game, there is no webcam. " +
        'Reply with JSON only, no prose: {"webcam":true,"region":"top-left|top-center|top-right|mid-left|mid-center|mid-right|bottom-left|bottom-center|bottom-right","size":"small|medium|large","confidence":0-100}. ' +
        "Use the region where the webcam overlay sits and its rough size. If you cannot clearly see a real webcam, reply {\"webcam\":false}. " +
        context,
      image: jpegBase64,
      max_tokens: 100,
    })) as { result?: { description?: string; response?: string } };
    const text = json.result?.description ?? json.result?.response ?? "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return hintFromText(text);
    try {
      return normaliseHint(JSON.parse(text.slice(start, end + 1)));
    } catch {
      return hintFromText(text);
    }
  } catch {
    return null;
  }
}

/**
 * Meta's Llama vision model needs its licence accepted once per account: the
 * first request must be `{ "prompt": "agree" }`. The operator triggers this
 * from Settings so the vision path cannot fail silently on a licence gate.
 */
export async function acceptVisionLicense(
  e: Env,
): Promise<{ ok: boolean; model: string; error?: string }> {
  const model = e.VISION_MODEL || "@cf/meta/llama-3.2-11b-vision-instruct";
  if (!aiConfigured(e)) {
    return { ok: false, model, error: "CF_ACCOUNT_ID and CF_AI_TOKEN are not set" };
  }
  try {
    await runModel(e, model, { prompt: "agree" });
    return { ok: true, model };
  } catch (err) {
    return { ok: false, model, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Image captioning for sampled frames. Returns null when AI is not configured. */
export async function describeFrame(
  e: Env,
  jpegBase64: string,
  prompt: string,
): Promise<{ text: string; provider: string; error?: string } | null> {
  if (!aiConfigured(e)) return null;
  const model = e.VISION_MODEL || "@cf/meta/llama-3.2-11b-vision-instruct";
  try {
    const json = (await runModel(e, model, {
      prompt,
      image: jpegBase64,
      max_tokens: 180,
    })) as { result?: { description?: string; response?: string } };
    const text = json.result?.description ?? json.result?.response ?? "";
    return { text, provider: model };
  } catch (err) {
    return { text: "", provider: model, error: err instanceof Error ? err.message : String(err) };
  }
}

function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface LoudnessSignal {
  db: number[];
  bucket: number;
  /** spike-relative time of the first bucket */
  start: number;
}

function loudnessSignal(input: MomentInput): LoudnessSignal | null {
  if (!input.loudness || input.loudness.length < 10) return null;
  const bucket = clamp(Number(input.loudnessBucketSec ?? 0.5), 0.2, 2);
  return {
    db: input.loudness,
    bucket,
    start: Number(input.windowStartSec ?? 0),
  };
}

/**
 * The loudest sustained point in the window is the reaction. Peaks that sit far
 * away from the chat spike are ignored: the ring buffer can contain a louder
 * intro or ad, and the spike is still why this moment exists.
 */
/** Loudness contrast around the moment, 0 when there is no usable audio. */
export function loudnessContrast(
  loudness: number[] | undefined,
  bucketSec = 0.5,
  windowStartSec = 0,
): number {
  const input = { loudness, loudnessBucketSec: bucketSec, windowStartSec } as unknown as MomentInput;
  return audioAnchor(input)?.contrastDb ?? 0;
}

export function audioAnchor(input: MomentInput): { atSec: number; contrastDb: number } | null {
  const signal = loudnessSignal(input);
  if (!signal) return null;
  const { db, bucket, start } = signal;

  const smoothed = db.map((_, i) => {
    const slice = db.slice(Math.max(0, i - 1), Math.min(db.length, i + 2));
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });

  const from = Math.max(start, -8);
  const to = Math.min(start + db.length * bucket, 3);
  const lo = Math.max(0, Math.ceil((from - start) / bucket));
  const hi = Math.min(smoothed.length - 1, Math.floor((to - start) / bucket));
  if (hi <= lo) return null;

  const values = smoothed.slice(lo, hi + 1);
  const max = Math.max(...values);
  const median = medianOf(values);
  const contrastDb = max - median;
  // A stream with wall-to-wall music has no contrast to find; fall back to the
  // chat peak instead of pretending its loudest second is a reaction.
  if (contrastDb < 3) return null;

  const index = values.findIndex((v) => v >= max - 2);
  return {
    atSec: clamp(start + (lo + index + 0.5) * bucket, -8, 2),
    contrastDb,
  };
}

/**
 * Chooses up to three cuts: the setup around the reaction, the loudest beat, and
 * a following beat when the moment keeps going. Peaks are separated and joined
 * so the assembled clip never replays the same footage.
 */
export function planBeats(input: MomentInput, anchorSec: number): MomentBeat[] {
  const maxTotal = clamp(input.maxClipSec ?? 24, 6, 60);
  const fallbackStart = clamp(anchorSec - 3, -20, 4);
  const fallback: MomentBeat[] = [
    {
      startSec: fallbackStart,
      endSec: Math.min(fallbackStart + 14, fallbackStart + Math.max(6, maxTotal)),
      score: 50,
    },
  ];

  const signal = loudnessSignal(input);
  if (!signal) return fallback;
  const { db, bucket, start } = signal;

  const smoothed = db.map((_, i) => {
    const slice = db.slice(Math.max(0, i - 1), Math.min(db.length, i + 2));
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
  const sorted = [...smoothed].sort((a, b) => a - b);
  const quantile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const floor = quantile(0.3);
  const ceiling = Math.max(floor + 2, quantile(0.92));
  const normalised = smoothed.map((v) => clamp((v - floor) / (ceiling - floor), 0, 1));

  // Speech is worth keeping even when it is not the loudest thing in the room.
  for (const segment of input.transcriptSegments ?? []) {
    const from = Math.floor(segment.startSec / bucket);
    const to = Math.ceil(segment.endSec / bucket);
    for (let i = Math.max(0, from); i < Math.min(normalised.length, to); i++) {
      normalised[i] = Math.min(1.2, normalised[i] + 0.18);
    }
  }

  // Only look around the moment; the window may hold a louder unrelated intro.
  const fromSec = Math.max(0, -10 - start);
  const toSec = Math.min(db.length * bucket, 14 - start);
  const lo = Math.max(1, Math.floor(fromSec / bucket));
  const hi = Math.min(normalised.length - 2, Math.ceil(toSec / bucket));

  const peaks: { atSec: number; score: number }[] = [];
  for (let i = lo; i <= hi; i++) {
    if (normalised[i] < 0.55) continue;
    if (normalised[i] < normalised[i - 1] || normalised[i] < normalised[i + 1]) continue;
    peaks.push({ atSec: start + (i + 0.5) * bucket, score: normalised[i] });
  }
  peaks.sort((a, b) => b.score - a.score);

  const chosen: { atSec: number; score: number }[] = [];
  for (const peak of peaks) {
    if (chosen.length >= 3) break;
    if (chosen.some((other) => Math.abs(other.atSec - peak.atSec) < 4.5)) continue;
    chosen.push(peak);
  }
  if (!chosen.length) return fallback;

  // Prefer to start and end on a spoken boundary so subtitles and cuts agree.
  const offset = Number(input.windowStartSec ?? 0);
  const bounds = (input.transcriptSegments ?? []).flatMap((s) => [
    offset + s.startSec,
    offset + s.endSec,
  ]);
  const snap = (t: number) => {
    let best = t;
    let bestGap = 1.1;
    for (const bound of bounds) {
      const gap = Math.abs(bound - t);
      if (gap < bestGap) {
        best = bound;
        bestGap = gap;
      }
    }
    return best;
  };

  let beats: MomentBeat[] = chosen
    .map((peak) => {
      let beatStart = snap(peak.atSec - 3.5);
      let beatEnd = snap(peak.atSec + 3.5);
      if (beatEnd - beatStart < 4) {
        beatStart = peak.atSec - 2;
        beatEnd = peak.atSec + 3;
      }
      return {
        startSec: clamp(beatStart, -20, 40),
        endSec: clamp(beatEnd, -20, 45),
        score: Math.min(100, Math.round(peak.score * 100)),
      };
    })
    .sort((a, b) => a.startSec - b.startSec);

  // Overlapping beats are one cut; replaying the same footage is not an edit.
  const merged: MomentBeat[] = [];
  for (const beat of beats) {
    const previous = merged[merged.length - 1];
    if (previous && beat.startSec <= previous.endSec + 0.4) {
      previous.endSec = Math.max(previous.endSec, beat.endSec);
    } else {
      merged.push({ ...beat });
    }
  }
  beats = merged;

  while (beats.length > 1 && beats.reduce((sum, b) => sum + (b.endSec - b.startSec), 0) > maxTotal) {
    const weakest = beats.reduce((a, b) => (b.score < a.score ? b : a));
    beats = beats.filter((b) => b !== weakest);
  }

  if (beats.length === 1 && beats[0].endSec - beats[0].startSec > maxTotal) {
    const middle = (beats[0].startSec + beats[0].endSec) / 2;
    beats[0] = {
      ...beats[0],
      startSec: middle - maxTotal / 2,
      endSec: middle + maxTotal / 2,
    };
  }

  return beats.length ? beats : fallback;
}

/** Remap Whisper segments onto the assembled clip's own timeline. */
export function captionsForBeats(
  segments: SpokenSegment[],
  windowStartSec: number,
  beats: MomentBeat[],
): TimedCaption[] {
  const out: TimedCaption[] = [];
  let cursor = 0;
  for (const beat of beats) {
    for (const segment of segments) {
      const from = Math.max(beat.startSec, windowStartSec + segment.startSec);
      const to = Math.min(beat.endSec, windowStartSec + segment.endSec);
      if (to - from < 0.3) continue;
      out.push({
        startSec: cursor + (from - beat.startSec),
        endSec: cursor + (to - beat.startSec),
        text: segment.text,
      });
    }
    cursor += beat.endSec - beat.startSec;
  }
  return out;
}

/**
 * Copy describes what happened in the clip itself. Chat reaction is a signal for
 * finding the moment, not the subject of it, so none of these mention chat.
 */
function heuristicCaptions(input: MomentInput, category: string): string[] {
  const n = input.channelName.toUpperCase();
  const g = (input.gameName ?? "the game").toUpperCase();
  if (category === "funny") {
    return [
      `BRO REALLY DID THAT 💀`,
      `NOT THE ${g} PLAY 💀`,
      `I WOULD HAVE UNINSTALLED`,
      `${n} HAS LOST IT`,
      `THAT WAS NOT IN THE SCRIPT`,
    ];
  }
  if (category === "dramatic") {
    return [
      `NAH THAT CLUTCH WAS INSANE`,
      `DOWN TO THE LAST SECOND`,
      `${n} CLUTCHED IT`,
      `IT WAS OVER AND HE SAVED IT`,
      `LAST CHANCE AND HE TOOK IT`,
    ];
  }
  if (category === "surprising") {
    return [
      `NOBODY SAW THAT COMING`,
      `WAIT WHAT JUST HAPPENED`,
      `${n} FLIPPED THE WHOLE ${g} GAME`,
      `THAT WAS NOT SUPPOSED TO WORK`,
      `INSTANT ${g} HIGHLIGHT`,
    ];
  }
  return [
    `${n} POPPED OFF`,
    `THAT ${g} PLAY WAS PERFECT`,
    `BEST MOMENT OF THE STREAM`,
    `HE MADE THAT LOOK EASY`,
    `REWATCH THIS ONE`,
  ];
}

function heuristicTitles(input: MomentInput, category: string): string[] {
  const g = input.gameName ?? "stream";
  if (category === "funny") return [`${input.channelName} loses it`, `Certified ${g} comedy`, `That went badly`];
  if (category === "dramatic") return [`${input.channelName} clutches it`, `Down to the wire`, `No way that happened`];
  if (category === "surprising") return [`${input.channelName} flips the game`, `Nobody saw this coming`, `Instant ${g} highlight`];
  return [`${input.channelName} pops off`, `${g} highlight`, `That was clean`];
}

export function heuristicAnalysis(input: MomentInput): MomentAnalysis {
  const { score, category, reasoning } = heuristicQuality(input.features);
  const captions = heuristicCaptions(input, category);
  const titles = heuristicTitles(input, category);
  const seed = Math.abs(Math.round(input.ts / 7)) % captions.length;
  const anchorSec = audioAnchor(input)?.atSec ?? 0;
  const beats = planBeats(input, anchorSec);
  return {
    summary: reasoning,
    whyChatReacted:
      `Chat rate jumped ${input.features.ratio}x in seconds with ` +
      `${Math.round(input.features.emoteRatio * 100)}% emote messages - a classic reaction burst.`,
    interesting: score >= 55,
    category: category as MomentAnalysis["category"],
    qualityScore: score,
    funniness: category === "funny" ? clamp(score + 6, 0, 100) : clamp(score - 18, 0, 100),
    // Offsets from the spike peak, not timestamps. The beats carry the actual
    // cuts; this span is just their outer envelope for display and old callers.
    beginsAtSec: beats[0].startSec,
    endsAtSec: beats[beats.length - 1].endSec,
    beats,
    anchorSec,
    funnySegmentIndices: [],
    title: titles[seed % titles.length],
    caption: captions[seed],
    hashtags: ["#twitch", "#clips", `#${(input.gameName ?? "gaming").toLowerCase().replace(/[^a-z0-9]/g, "")}`, "#fyp"],
    provider: "heuristic",
    model: "clipforge-signal-v1",
  };
}

const PROMPT = `You are the editor of a Twitch highlights channel. Your audience is gamers scrolling TikTok/Shorts/Reels, not the streamer.
Reply with JSON only, no prose, matching this shape:
{"summary":"one sentence on what happened in the clip","whyChatReacted":"one sentence on the chat reaction","interesting":true,"category":"funny|exciting|surprising|dramatic|boring","qualityScore":0-100,"funniness":0-100,"funnySegmentIndices":[0],"beginsAtSec":number,"endsAtSec":number,"title":"short title","caption":"ALL CAPS caption under 60 chars","hashtags":["#tag"]}
Rules:
- Read the transcript segments. Pick the 1-3 segments a gaming audience would actually find funny or impressive: a punchline, a rage, a fail, an unexpected outcome, a clutch callout. Rank them best first in funnySegmentIndices and use only the supplied [n] indices. If nothing is genuinely funny or impressive, return [].
- Do not pick greetings, thanks, sub/donation callouts, reading the game UI, or setup with no payoff. Do not pick a line that only makes sense with context that is not in the transcript.
- The clip is cut around the chosen lines, so the pick matters more than the wording.
- beginsAtSec and endsAtSec are OFFSETS IN SECONDS FROM THE SPIKE PEAK, not timestamps. 0 is the peak, negative is footage before it. They are advisory: the cuts come from funnySegmentIndices.
- title and caption describe what HAPPENED IN THE VIDEO: the play, the reaction, the outcome. Never mention chat, viewers, donations or "chat going wild" - the chat is only how the moment was found, it is not the story.
- Prefer concrete wording (the play, the game, the outcome) over generic hype.
- The title must be specific to this moment and different from every recent title supplied. Never reuse or lightly reword one.
- Repeating short answers (1, 2, A, B, yes, no, !vote) means chat is voting in a poll or running a command, not reacting. A poll is not a moment by itself: only pick a segment if something genuinely funny or impressive happens on stream during it. If nothing does, return [] and keep the funniness low.`;

function safeParse(text: string): Partial<MomentAnalysis> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Partial<MomentAnalysis>;
  } catch {
    return null;
  }
}

export async function analyzeMoment(e: Env, input: MomentInput): Promise<MomentAnalysis> {
  const fallback = heuristicAnalysis(input);
  if (!e.AI_MODEL && !aiConfigured(e)) return fallback;

  const model = e.AI_MODEL || DEFAULT_AI_MODEL;
  const offset = Number(input.windowStartSec ?? 0);
  const timedTranscript = (input.transcriptSegments ?? [])
    .map(
      (segment, index) =>
        `[${index}] ${(offset + segment.startSec).toFixed(1)}s to ${(offset + segment.endSec).toFixed(1)}s: ${segment.text}`,
    )
    .join("\n");
  const context = [
    `Channel: ${input.channelName}`,
    `Game: ${input.gameName ?? "unknown"}`,
    `Stream title: ${input.streamTitle ?? "unknown"}`,
    `Chat features: ${JSON.stringify(input.features)}`,
    `Chat sample:\n${input.messages.slice(0, 18).join("\n")}`,
    input.pollHint ? `Chat pattern: ${input.pollHint} - this is a vote, not a reaction.` : "",
    input.contextHint
      ? "Operator note: this moment needs extra context. Start the first cut earlier and keep the setup lines that lead into the payoff; do not add unrelated filler."
      : "",
    input.avoidTitles?.length
      ? `Recent titles (do not reuse or reword any of these):\n${input.avoidTitles.slice(0, 40).join("\n")}`
      : "",
    timedTranscript
      ? `Transcript segments (times relative to the spike peak):\n${timedTranscript.slice(0, 2400)}`
      : input.transcript
        ? `Audio transcript: ${input.transcript.slice(0, 800)}`
        : "No speech transcript available.",
    input.visualNotes?.length
      ? `Sampled frames:\n${input.visualNotes.map((v, i) => `frame ${i + 1}: ${v}`).join("\n")}`
      : "No visual analysis available - judge from chat and audio only.",
  ]
    .filter(Boolean)
    .join("\n");

  const systemPrompt = withDirection(PROMPT, input.direction);

  try {
    const json = (await runModel(e, model, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: context },
      ],
      max_tokens: 420,
      temperature: 0.7,
    })) as { result?: { response?: string } };

    const parsed = safeParse(json.result?.response ?? "");
    if (!parsed) return fallback;

    const rawIndices = (parsed as { funnySegmentIndices?: unknown }).funnySegmentIndices;
    const indexList = Array.isArray(rawIndices)
      ? rawIndices
      : typeof rawIndices === "string"
        ? rawIndices.split(/[,\s]+/)
        : [];
    const funnySegmentIndices = indexList
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0)
      .slice(0, 3);

    const score = clamp(Math.round(Number(parsed.qualityScore ?? fallback.qualityScore)), 0, 100);
    return {
      summary: String(parsed.summary ?? fallback.summary).slice(0, 400),
      whyChatReacted: String(parsed.whyChatReacted ?? fallback.whyChatReacted).slice(0, 400),
      interesting: Boolean(parsed.interesting ?? score >= 55),
      category: (parsed.category as MomentAnalysis["category"]) ?? fallback.category,
      qualityScore: score,
      funniness: clamp(Math.round(Number(parsed.funniness ?? fallback.funniness)), 0, 100),
      // The audio plan is grounded in when the reaction happened; the model's
      // span is a guess made without timings, so the plan wins.
      beginsAtSec: fallback.beginsAtSec,
      endsAtSec: fallback.endsAtSec,
      beats: fallback.beats,
      anchorSec: fallback.anchorSec,
      funnySegmentIndices,
      title: String(parsed.title ?? fallback.title).slice(0, 90),
      caption: String(parsed.caption ?? fallback.caption).slice(0, 90).toUpperCase(),
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 6).map(String) : fallback.hashtags,
      provider: "workers-ai",
      model,
    };
  } catch {
    return fallback;
  }
}

/**
 * A fresh title and caption for one clip. The two are generated together so
 * they describe the same moment without repeating each other; the differences
 * from every other clip are enforced by the caller with lib/titles.
 */
export async function regenerateCopy(
  e: Env,
  input: MomentInput,
  previous: { title: string; caption: string },
  options: { avoidTitles?: string[]; avoidCaptions?: string[]; direction?: string } = {},
): Promise<{ title: string; caption: string; provider: string }> {
  const base = heuristicAnalysis(input);
  const rotate = (list: string[], current: string): string => {
    const fresh = list.filter(
      (value) => value.trim().toLowerCase() !== current.trim().toLowerCase(),
    );
    const pool = fresh.length ? fresh : list;
    return pool[Math.floor(Math.random() * pool.length)] ?? list[0];
  };
  const heuristic = {
    title: rotate(heuristicTitles(input, base.category), previous.title),
    caption: rotate(heuristicCaptions(input, base.category), previous.caption),
  };
  if (!aiConfigured(e)) return { ...heuristic, provider: "heuristic" };

  const model = e.AI_MODEL || DEFAULT_AI_MODEL;
  try {
    const json = (await runModel(e, model, {
      messages: [
        {
          role: "system",
          content:
            "Write the title and caption for one Twitch clip. Reply with JSON only, no prose: " +
            '{"title":"...","caption":"..."}. ' +
            "The title is 3-9 words, sentence case, specific to what happened in the video. " +
            "The caption is a different phrase from the title - a punchline or reaction line, ALL CAPS, under 60 characters. " +
            "No hashtags, no quotes, no emoji spam. Never mention chat, viewers or donations. " +
            "Do not reuse or lightly reword the previous title or caption, or any title in the used list." +
            captionDirectionSuffix(options.direction ?? ""),
        },
        {
          role: "user",
          content: [
            `Channel ${input.channelName}, game ${input.gameName ?? "unknown"}.`,
            `What happened: ${input.summary ?? "a notable moment on stream"}.`,
            `Previous title (do not repeat): ${previous.title}`,
            `Previous caption (do not repeat): ${previous.caption}`,
            options.avoidTitles?.length
              ? `Titles already used:\n${options.avoidTitles.slice(0, 30).join("\n")}`
              : "",
            options.avoidCaptions?.length
              ? `Captions already used:\n${options.avoidCaptions.slice(0, 30).join("\n")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      max_tokens: 140,
      temperature: 0.95,
    })) as { result?: { response?: string } };
    const parsed = safeParse(json.result?.response ?? "");
    const title = String(parsed?.title ?? "")
      .trim()
      .replace(/^["']|["']$/g, "")
      .slice(0, 90);
    const caption = String(parsed?.caption ?? "")
      .trim()
      .replace(/^["']|["']$/g, "")
      .slice(0, 80)
      .toUpperCase();
    if (!title && !caption) return { ...heuristic, provider: "heuristic" };
    return {
      title: title || heuristic.title,
      caption: caption || heuristic.caption,
      provider: "workers-ai",
    };
  } catch {
    return { ...heuristic, provider: "heuristic" };
  }
}

export async function regenerateCaption(
  e: Env,
  input: MomentInput,
  previous: string,
  direction = "",
): Promise<{ caption: string; provider: string }> {
  if (!aiConfigured(e)) {
    const options = heuristicCaptions(input, "funny").filter((c) => c !== previous);
    return {
      caption: options[Math.floor(Math.random() * options.length)] ?? "CAUGHT IN 4K 💀",
      provider: "heuristic",
    };
  }
  const model = e.AI_MODEL || DEFAULT_AI_MODEL;
  try {
    const json = (await runModel(e, model, {
      messages: [
        {
          role: "system",
          content:
            "Write one ALL-CAPS meme caption for a Twitch clip, under 60 characters, no hashtags, no quotes, no emoji unless it lands. Reply with the caption only." +
            captionDirectionSuffix(direction),
        },
        {
          role: "user",
          content: `Channel ${input.channelName}, game ${input.gameName ?? "unknown"}. What happened: ${input.summary ?? "chat exploded"}. Previous caption (do not repeat): ${previous}`,
        },
      ],
      max_tokens: 40,
      temperature: 0.95,
    })) as { result?: { response?: string } };
    const text = (json.result?.response ?? "").trim().replace(/^["']|["']$/g, "");
    if (!text) return { caption: previous, provider: "heuristic" };
    return { caption: text.slice(0, 80).toUpperCase(), provider: "workers-ai" };
  } catch {
    return { caption: previous, provider: "heuristic" };
  }
}
