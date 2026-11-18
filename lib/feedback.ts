import type { AppSettings } from "./types";

export type FeedbackSentiment = "like" | "dislike";

export interface ClipFeedback {
  clip_id: string;
  sentiment: FeedbackSentiment;
  reasons_json: string | null;
  note: string | null;
  quality_at: number | null;
  created_at: string;
  updated_at: string;
}

/** Thumbs, plus the optional detail that tells the pipeline what to change. */
export const SENTIMENTS: {
  key: FeedbackSentiment;
  label: string;
  short: string;
}[] = [
  { key: "like", label: "Like", short: "liked" },
  { key: "dislike", label: "Dislike", short: "disliked" },
];

/**
 * Reactions are about the viewer's taste, not the model's score. The pipeline
 * can only learn from them if they map onto a concrete knob, so every reason
 * below either informs the quality floor or the cut window.
 */
export const REASONS: { slug: string; label: string }[] = [
  { slug: "funny", label: "Actually funny" },
  { slug: "want_more", label: "Want more of this" },
  { slug: "boring", label: "Boring" },
  { slug: "cut_missed", label: "Cut missed the moment" },
  { slug: "too_long", label: "Dragged on" },
  { slug: "bad_subs", label: "Subtitles off" },
  { slug: "chat_heavy", label: "Too much chat" },
  { slug: "wrong_game", label: "Wrong game / channel" },
];

export const REASON_LABEL: Record<string, string> = Object.fromEntries(
  REASONS.map((r) => [r.slug, r.label]),
);

/** Reasons that point at the edit rather than at taste. */
const EDIT_REASONS = new Set(["cut_missed", "too_long"]);
/** Reasons that point at which moments get picked at all. */
const TASTE_REASONS = new Set(["boring", "wrong_game", "chat_heavy"]);

export function sentimentLabel(sentiment: string): string {
  return SENTIMENTS.find((s) => s.key === sentiment)?.short ?? "unrated";
}

export function parseReasons(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is string => typeof item === "string" && item in REASON_LABEL,
    );
  } catch {
    return [];
  }
}

export interface FeedbackSuggestion {
  patch: Partial<
    Pick<AppSettings, "minQualityScore" | "preEventSec" | "clipDurationSec">
  >;
  headline: string;
  detail: string;
}

export interface FeedbackSummary {
  total: number;
  liked: number;
  disliked: number;
  reasons: { slug: string; label: string; count: number }[];
  suggestion: FeedbackSuggestion | null;
}

const step5 = (n: number) => Math.max(0, Math.min(95, Math.round(n / 5) * 5));

/**
 * Turns reactions into a concrete settings change. Kept intentionally simple
 * and reversible: it proposes one edit at a time and explains why.
 */
export function suggestFilters(
  feedback: ClipFeedback[],
  settings: AppSettings,
  reasons: FeedbackSummary["reasons"] = [],
): FeedbackSuggestion | null {
  const rated = feedback.filter((f) => typeof f.quality_at === "number");
  const liked = rated.filter((f) => f.sentiment === "like");

  // A floor above a clip you liked is provably too strict.
  if (liked.length > 0) {
    const lowest = Math.min(...liked.map((f) => f.quality_at as number));
    const target = step5(lowest - 5);
    if (target < settings.minQualityScore) {
      return {
        patch: { minQualityScore: target },
        headline: `Lower the quality floor to ${target}`,
        detail: `A clip you liked scored ${lowest}, so the floor of ${settings.minQualityScore} would have skipped moments like it. This lets that clip through and everything scored above it.`,
      };
    }
  }

  // Taste is fine but the edit is wrong: move the cut window instead.
  const ranked = reasons.length > 0 ? reasons : reasonCounts(feedback);
  const editVotes = ranked
    .filter((r) => EDIT_REASONS.has(r.slug))
    .reduce((sum, r) => sum + r.count, 0);
  const tasteVotes = ranked
    .filter((r) => TASTE_REASONS.has(r.slug))
    .reduce((sum, r) => sum + r.count, 0);

  if (editVotes >= 2 && editVotes > tasteVotes) {
    const top = ranked.find((r) => EDIT_REASONS.has(r.slug));
    if (top?.slug === "cut_missed") {
      const target = Math.min(30, settings.preEventSec + 4);
      if (target > settings.preEventSec) {
        return {
          patch: { preEventSec: target },
          headline: `Start cuts ${target - settings.preEventSec}s earlier`,
          detail: `You flagged ${editVotes} edit${editVotes === 1 ? "" : "s"} where the cut missed the moment, so the pre-event buffer moves from ${settings.preEventSec}s to ${target}s.`,
        };
      }
    }
    if (top?.slug === "too_long") {
      const target = Math.max(6, settings.clipDurationSec - 4);
      if (target < settings.clipDurationSec) {
        return {
          patch: { clipDurationSec: target },
          headline: `Trim clips to ${target}s`,
          detail: `Clips felt long in your feedback, so the target duration moves from ${settings.clipDurationSec}s to ${target}s. The analyser can still end a clip sooner when the moment is shorter.`,
        };
      }
    }
  }

  return null;
}

function reasonCounts(feedback: ClipFeedback[]): FeedbackSummary["reasons"] {
  const counts = new Map<string, number>();
  for (const item of feedback) {
    for (const slug of parseReasons(item.reasons_json)) {
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([slug, count]) => ({ slug, label: REASON_LABEL[slug] ?? slug, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function summariseFeedback(
  feedback: ClipFeedback[],
  settings: AppSettings,
): FeedbackSummary {
  const reasons = reasonCounts(feedback);

  return {
    total: feedback.length,
    liked: feedback.filter((f) => f.sentiment === "like").length,
    disliked: feedback.filter((f) => f.sentiment === "dislike").length,
    reasons,
    suggestion: suggestFilters(feedback, settings, reasons),
  };
}
