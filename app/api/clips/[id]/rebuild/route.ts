import { db, ensureAnalyzeColumn, getSettings } from "@/lib/db";
import { json, readJson } from "@/lib/api";
import { denied } from "@/lib/guard";
import { getAllFeedback } from "@/lib/queries";
import { summariseFeedback } from "@/lib/feedback";
import { WEBCAM_REGIONS } from "@/lib/webcam";
import type { Clip } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Re-cuts one clip using the suggestion derived from feedback, without touching
 * the saved defaults. The settings ride on the spike, the analyser reads them,
 * and the collector picks the moment up on its next queue drain.
 */
interface RebuildBody {
  /** extend this cut instead of just re-running it */
  makeLonger?: boolean;
  /** include the setup around the moment, not only the payoff */
  needsContext?: boolean;
  /** force a corner when auto-detection picked the wrong one, or "none" */
  webcamRegion?: string;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
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
    const body = (await readJson<RebuildBody>(req)) ?? {};
    // Reprocessing works with or without a suggestion. With none, the moment is
    // re-analysed and re-rendered using the saved defaults.
    const suggestion = summariseFeedback(feedback, settings).suggestion;
    const patch: Record<string, unknown> = { ...(suggestion?.patch ?? {}) };

    if (body.makeLonger) {
      const measured = Number(clip.duration_ms) / 1000;
      const currentSec = Number.isFinite(measured) && measured > 0
        ? Math.max(6, Math.min(60, Math.round(measured)))
        : settings.clipDurationSec;
      // Ten more seconds, and the analyser also widens each cut so the extra
      // time is real footage rather than padding.
      patch.clipDurationSec = Math.min(60, currentSec + 10);
      patch.longer = true;
    }
    if (body.needsContext) patch.needsContext = true;
    if (
      typeof body.webcamRegion === "string" &&
      (body.webcamRegion === "none" || WEBCAM_REGIONS.includes(body.webcamRegion))
    ) {
      patch.webcamRegion = body.webcamRegion;
    }

    await ensureAnalyzeColumn(d);
    await d
      .prepare("UPDATE spikes SET analyze_json = ?, status = 'queued' WHERE id = ?")
      .bind(Object.keys(patch).length ? JSON.stringify(patch) : null, clip.spike_id)
      .run();

    return json({ ok: true, queued: true, patch: Object.keys(patch).length ? patch : null });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
