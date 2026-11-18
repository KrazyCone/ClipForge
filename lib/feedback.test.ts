import test from "node:test";
import assert from "node:assert/strict";
import { parseReasons, summariseFeedback, suggestFilters } from "./feedback.ts";
import type { ClipFeedback } from "./feedback.ts";
import { DEFAULT_SETTINGS } from "./types.ts";
import type { AppSettings } from "./types.ts";

const settings: AppSettings = { ...DEFAULT_SETTINGS, minQualityScore: 60 };

function feedback(
  clipId: string,
  sentiment: "like" | "dislike",
  quality: number,
  reasons: string[] = [],
): ClipFeedback {
  return {
    clip_id: clipId,
    sentiment,
    reasons_json: JSON.stringify(reasons),
    note: null,
    quality_at: quality,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

test("a liked clip below the floor lowers the floor", () => {
  const suggestion = suggestFilters([feedback("a", "like", 52)], settings);
  assert.ok(suggestion);
  assert.equal(suggestion!.patch.minQualityScore, 45);
  assert.match(suggestion!.headline, /Lower the quality floor to 45/);
});

test("no suggestion when everything liked already clears the floor", () => {
  const suggestion = suggestFilters(
    [feedback("a", "like", 74), feedback("b", "dislike", 40)],
    settings,
  );
  assert.equal(suggestion, null);
});

test("repeated cut complaints widen the pre-event buffer", () => {
  const suggestion = suggestFilters(
    [
      feedback("a", "dislike", 50, ["cut_missed"]),
      feedback("b", "dislike", 48, ["cut_missed"]),
    ],
    settings,
  );
  assert.ok(suggestion);
  assert.equal(suggestion!.patch.preEventSec, settings.preEventSec + 4);
});

test("taste complaints do not move the cut window", () => {
  const suggestion = suggestFilters(
    [
      feedback("a", "dislike", 50, ["boring"]),
      feedback("b", "dislike", 48, ["wrong_game"]),
    ],
    settings,
  );
  assert.equal(suggestion, null);
});

test("summary counts and unknown reason slugs are ignored", () => {
  const summary = summariseFeedback(
    [
      feedback("a", "like", 70, ["funny", "not_a_reason"]),
      feedback("b", "dislike", 40, ["boring"]),
    ],
    settings,
  );
  assert.equal(summary.total, 2);
  assert.equal(summary.liked, 1);
  assert.equal(summary.disliked, 1);
  assert.deepEqual(parseReasons(JSON.stringify(["funny", "not_a_reason"])), ["funny"]);
  assert.equal(summary.reasons.length, 2);
});

test("malformed reason JSON is treated as empty", () => {
  assert.deepEqual(parseReasons("not json"), []);
  assert.deepEqual(parseReasons(null), []);
});
