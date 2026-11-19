import { db, ensureAnalyzeColumn, getSettings } from "@/lib/db";
import { json, readJson } from "@/lib/api";
import { denied } from "@/lib/guard";
import { getAllFeedback } from "@/lib/queries";
import { parseReasons, REASON_LABEL, summariseFeedback } from "@/lib/feedback";
import { WEBCAM_REGIONS } from "@/lib/webcam";
import { nudgeRenderer } from "@/lib/workflow";
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
  /** copy typed in the clip modal, kept on the re-cut */
  title?: string;
  caption?: string;
  /** what the operator wants changed about this cut, in their words */
  direction?: string;
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

    // Copy the operator typed into the modal survives the re-cut instead of
    // being overwritten by whatever the model writes next.
    if (typeof body.title === "string" && body.title.trim()) {
      patch.title = body.title.trim().slice(0, 120);
    }
    if (typeof body.caption === "string" && body.caption.trim()) {
      patch.caption = body.caption.trim().slice(0, 120);
    }

    // What the operator wrote is instruction, not just telemetry. The re-cut
    // box wins when it was used; otherwise the note saved under "Your take"
    // is what they already told us about this clip.
    const saved = feedback.find((row) => row.clip_id === id);
    const typed = typeof body.direction === "string" ? body.direction.trim() : (saved?.note ?? "").trim();
    const reasons = parseReasons(saved?.reasons_json).map((slug) => REASON_LABEL[slug] ?? slug);
    const direction = [
      typed.slice(0, 600),
      reasons.length ? `Their reaction to the previous cut: ${reasons.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (direction) patch.direction = direction;

    await ensureAnalyzeColumn(d);
    await d
      .prepare("UPDATE spikes SET analyze_json = ?, status = 'queued' WHERE id = ?")
      // "{}" still marks the spike as a re-cut, which is how the collector
      // knows it may use the live buffer instead of the archive VOD.
      .bind(JSON.stringify(patch), clip.spike_id)
      .run();

    // Ask for a renderer run now rather than leaving the re-cut to the next
    // scheduled one; without a dispatch token this quietly does nothing.
    const dispatched = await nudgeRenderer("clip rebuild");

    return json({
      ok: true,
      queued: true,
      dispatched,
      patch: Object.keys(patch).length ? patch : null,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
