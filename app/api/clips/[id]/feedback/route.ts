import { db, ensureFeedbackTable } from "@/lib/db";
import { json, readJson } from "@/lib/api";
import { denied } from "@/lib/guard";
import { REASON_LABEL } from "@/lib/feedback";
import type { ClipFeedback, FeedbackSentiment } from "@/lib/feedback";
import type { Clip } from "@/lib/types";

export const dynamic = "force-dynamic";

const SENTIMENTS = new Set<FeedbackSentiment>(["like", "dislike"]);

/** Save (or replace) the owner's reaction to one clip. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await denied();
  if (gate) return gate;
  const { id } = await ctx.params;
  const body = await readJson<{
    sentiment?: string;
    reasons?: unknown;
    note?: string;
  }>(req);
  if (!body) return json({ error: "invalid body" }, 400);

  const sentiment = String(body.sentiment ?? "") as FeedbackSentiment;
  if (!SENTIMENTS.has(sentiment)) {
    return json({ error: "sentiment must be like or dislike" }, 400);
  }

  const reasons = Array.isArray(body.reasons)
    ? [
        ...new Set(
          body.reasons.filter(
            (r): r is string => typeof r === "string" && r in REASON_LABEL,
          ),
        ),
      ].slice(0, 8)
    : [];
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";

  try {
    const d = await db();
    const clip = await d
      .prepare("SELECT id, quality_score FROM clips WHERE id = ?")
      .bind(id)
      .first<Pick<Clip, "id" | "quality_score">>();
    if (!clip) return json({ error: "clip not found" }, 404);

    await ensureFeedbackTable(d);
    const now = new Date().toISOString();
    await d
      .prepare(
        `INSERT INTO clip_feedback
           (clip_id, sentiment, reasons_json, note, quality_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(clip_id) DO UPDATE SET
           sentiment = excluded.sentiment,
           reasons_json = excluded.reasons_json,
           note = excluded.note,
           quality_at = excluded.quality_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        id,
        sentiment,
        JSON.stringify(reasons),
        note || null,
        clip.quality_score ?? null,
        now,
        now,
      )
      .run();

    const feedback = await d
      .prepare("SELECT * FROM clip_feedback WHERE clip_id = ?")
      .bind(id)
      .first<ClipFeedback>();
    return json({ feedback });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/** Clear the reaction so the clip counts as unrated again. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await denied();
  if (gate) return gate;
  const { id } = await ctx.params;
  try {
    const d = await db();
    await ensureFeedbackTable(d);
    await d.prepare("DELETE FROM clip_feedback WHERE clip_id = ?").bind(id).run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
