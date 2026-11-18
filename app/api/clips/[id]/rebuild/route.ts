import { db, ensureAnalyzeColumn, getSettings } from "@/lib/db";
import { json } from "@/lib/api";
import { denied } from "@/lib/guard";
import { getAllFeedback } from "@/lib/queries";
import { summariseFeedback } from "@/lib/feedback";
import type { Clip } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Re-cuts one clip using the suggestion derived from feedback, without touching
 * the saved defaults. The settings ride on the spike, the analyser reads them,
 * and the collector picks the moment up on its next queue drain.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await denied();
  if (gate) return gate;
  const { id } = await ctx.params;

  try {
    const d = await db();
    const clip = await d.prepare("SELECT * FROM clips WHERE id = ?").bind(id).first<Clip>();
    if (!clip) return json({ error: "clip not found" }, 404);
    if (!clip.spike_id) {
      return json({ error: "This clip has no source moment to re-analyse." }, 400);
    }

    const [settings, feedback] = await Promise.all([getSettings(), getAllFeedback()]);
    const suggestion = summariseFeedback(feedback, settings).suggestion;
    if (!suggestion) {
      return json(
        { error: "No suggestion yet — like or dislike a few clips first." },
        400,
      );
    }

    await ensureAnalyzeColumn(d);
    await d
      .prepare("UPDATE spikes SET analyze_json = ?, status = 'queued' WHERE id = ?")
      .bind(JSON.stringify(suggestion.patch), clip.spike_id)
      .run();

    return json({ ok: true, queued: true, patch: suggestion.patch });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
