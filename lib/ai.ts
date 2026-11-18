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
  /** prior assessment summary, used when regenerating copy */
  summary?: string;
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

/** Speech-to-text via Workers AI Whisper. Returns "" when unavailable. */
export async function transcribe(
  e: Env,
  audio: ArrayBuffer,
): Promise<{ text: string; provider: string } | null> {
  if (!aiConfigured(e)) return null;
  const model = e.STT_MODEL || "@cf/openai/whisper-large-v3-turbo";
  try {
    const binary = [...new Uint8Array(audio)];
    const json = (await runModel(e, model, { audio: binary })) as {
      result?: { text?: string };
    };
    return { text: json.result?.text ?? "", provider: model };
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

function heuristicCaptions(input: MomentInput, category: string): string[] {
  const n = input.channelName;
  const vibe = category === "funny" ? "BRO" : category === "dramatic" ? "NAH" : "WAIT";
  return [
    `${vibe} ${n.toUpperCase()} DID NOT JUST DO THAT 💀`,
    `THE CHAT WAS NOT READY FOR THIS`,
    `I WOULD HAVE UNINSTALLED`,
    `${n} BROKE THE GAME AND THE CHAT`,
    `THIS IS WHY YOU WATCH LIVE`,
  ];
}

function heuristicTitles(input: MomentInput, category: string): string[] {
  const g = input.gameName ?? "stream";
  if (category === "funny") return [`${input.channelName} breaks chat`, `Certified ${g} comedy`, `Chat lost it`];
  if (category === "dramatic") return [`${input.channelName} clutches it`, `Down to the wire`, `No way that happened`];
  if (category === "surprising") return [`${input.channelName} flips the game`, `Nobody saw this coming`, `Instant ${g} highlight`];
  return [`${input.channelName} pops off`, `${g} highlight`, `Chat goes wild`];
}

export function heuristicAnalysis(input: MomentInput): MomentAnalysis {
  const { score, category, reasoning } = heuristicQuality(input.features);
  const captions = heuristicCaptions(input, category);
  const titles = heuristicTitles(input, category);
  const seed = Math.abs(Math.round(input.ts / 7)) % captions.length;
  const duration = clamp(Math.round(input.features.burstEnd - input.features.burstStart), 8, 30);
  return {
    summary: reasoning,
    whyChatReacted:
      `Chat rate jumped ${input.features.ratio}x in seconds with ` +
      `${Math.round(input.features.emoteRatio * 100)}% emote messages - a classic reaction burst.`,
    interesting: score >= 55,
    category: category as MomentAnalysis["category"],
    qualityScore: score,
    funniness: category === "funny" ? clamp(score + 6, 0, 100) : clamp(score - 18, 0, 100),
    beginsAtSec: input.features.burstStart,
    endsAtSec: input.features.burstStart + duration,
    title: titles[seed % titles.length],
    caption: captions[seed],
    hashtags: ["#twitch", "#clips", `#${(input.gameName ?? "gaming").toLowerCase().replace(/[^a-z0-9]/g, "")}`, "#fyp"],
    provider: "heuristic",
    model: "clipforge-signal-v1",
  };
}

const PROMPT = `You analyse Twitch chat and stream signals to decide whether a moment is worth clipping for TikTok/Shorts/Reels.
Reply with JSON only, no prose, matching this shape:
{"summary":"one sentence on what happened","whyChatReacted":"one sentence","interesting":true,"category":"funny|exciting|surprising|dramatic|boring","qualityScore":0-100,"funniness":0-100,"beginsAtSec":number,"endsAtSec":number,"title":"short title","caption":"ALL CAPS meme caption under 60 chars","hashtags":["#tag"]}`;

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
  const context = [
    `Channel: ${input.channelName}`,
    `Game: ${input.gameName ?? "unknown"}`,
    `Stream title: ${input.streamTitle ?? "unknown"}`,
    `Chat features: ${JSON.stringify(input.features)}`,
    `Chat sample:\n${input.messages.slice(0, 18).join("\n")}`,
    input.transcript ? `Audio transcript: ${input.transcript.slice(0, 800)}` : "",
    input.visualNotes?.length
      ? `Sampled frames:\n${input.visualNotes.map((v, i) => `frame ${i + 1}: ${v}`).join("\n")}`
      : "No visual analysis available - judge from chat and audio only.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const json = (await runModel(e, model, {
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: context },
      ],
      max_tokens: 420,
      temperature: 0.7,
    })) as { result?: { response?: string } };

    const parsed = safeParse(json.result?.response ?? "");
    if (!parsed) return fallback;

    const score = clamp(Math.round(Number(parsed.qualityScore ?? fallback.qualityScore)), 0, 100);
    return {
      summary: String(parsed.summary ?? fallback.summary).slice(0, 400),
      whyChatReacted: String(parsed.whyChatReacted ?? fallback.whyChatReacted).slice(0, 400),
      interesting: Boolean(parsed.interesting ?? score >= 55),
      category: (parsed.category as MomentAnalysis["category"]) ?? fallback.category,
      qualityScore: score,
      funniness: clamp(Math.round(Number(parsed.funniness ?? fallback.funniness)), 0, 100),
      beginsAtSec: Number(parsed.beginsAtSec ?? fallback.beginsAtSec),
      endsAtSec: Number(parsed.endsAtSec ?? fallback.endsAtSec),
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

export async function regenerateCaption(
  e: Env,
  input: MomentInput,
  previous: string,
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
            "Write one ALL-CAPS meme caption for a Twitch clip, under 60 characters, no hashtags, no quotes, no emoji unless it lands. Reply with the caption only.",
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
