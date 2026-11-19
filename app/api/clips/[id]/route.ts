import { db, ensureClipStateColumns, files } from "@/lib/db";
import { nudgeRenderer } from "@/lib/workflow";
import { json, readJson } from "@/lib/api";
import type { Clip } from "@/lib/types";
import { denied } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * Hands a clip back to the renderer and drops the current file, so the card
 * shows it as processing until the new render lands.
 */
async function requeueRender(
  d: D1Database,
  clip: Clip,
  options: { markRecut?: boolean } = {},
): Promise<void> {
  try {
    const store = await files();
    const keys = [clip.r2_key, clip.thumb_key].filter(Boolean) as string[];
    if (keys.length) await store.delete(keys);
  } catch {
    /* the asset may already be gone */
  }
  await ensureClipStateColumns(d);
  const now = new Date().toISOString();
  await d
    .prepare(
      `UPDATE clips SET status = 'pending', r2_key = NULL, thumb_key = NULL, bytes = NULL,
         error = NULL, watched_at = NULL${options.markRecut ? ", recut_at = ?" : ""}, updated_at = ?
       WHERE id = ?`,
    )
    .bind(...(options.markRecut ? [now, now, clip.id] : [now, clip.id]))
    .run();
  if (clip.spike_id) {
    await d.prepare("UPDATE spikes SET status = 'rendering' WHERE id = ?").bind(clip.spike_id).run();
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await denied();
  if (gate) return gate;
  const { id } = await ctx.params;
  const body = await readJson<{
    title?: string;
    caption?: string;
    description?: string;
    reprocess?: boolean;
  }>(req);
  if (!body) return json({ error: "invalid body" }, 400);

  // Reprocess: drop the rendered asset and hand the clip back to the renderer.
  if (body.reprocess) {
    try {
      const d = await db();
      const clip = await d.prepare("SELECT * FROM clips WHERE id = ?").bind(id).first<Clip>();
      if (!clip) return json({ error: "clip not found" }, 404);
      // The coming file is a new cut, so it counts as recently re-cut.
      await requeueRender(d, clip, { markRecut: true });
      // Start a renderer run now instead of waiting for the next scheduled one.
      const dispatched = await nudgeRenderer("clip reprocess");
      return json({ ok: true, queued: true, dispatched });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  if (typeof body.title === "string") {
    sets.push("title = ?");
    values.push(body.title.slice(0, 120));
  }
  if (typeof body.caption === "string") {
    sets.push("caption = ?");
    values.push(body.caption.slice(0, 120));
  }
  if (typeof body.description === "string") {
    sets.push("description = ?");
    values.push(body.description.slice(0, 500));
  }
  if (!sets.length) return json({ error: "nothing to update" }, 400);

  try {
    const d = await db();
    const clip = await d.prepare("SELECT * FROM clips WHERE id = ?").bind(id).first<Clip>();
    if (!clip) return json({ error: "clip not found" }, 404);

    sets.push("updated_at = ?");
    values.push(new Date().toISOString(), id);
    await d.prepare(`UPDATE clips SET ${sets.join(", ")} WHERE id = ?`).bind(...values).run();

    // A clip with no spoken subtitles carries its caption as a card burned into
    // the video, so saving a new caption only changes the listing until the
    // file is rendered again. Rendering is what makes the video match the text.
    const captionChanged =
      typeof body.caption === "string" && body.caption.trim() !== (clip.caption ?? "").trim();
    const captionIsBurned = !(clip.transcript ?? "").trim();
    let reburn = false;
    if (captionChanged && captionIsBurned && clip.status === "ready") {
      await requeueRender(d, clip);
      await nudgeRenderer("caption re-burn");
      reburn = true;
    }
    return json({ ok: true, reburn });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await denied();
  if (gate) return gate;
  const { id } = await ctx.params;
  try {
    const d = await db();
    const clip = await d.prepare("SELECT * FROM clips WHERE id = ?").bind(id).first<Clip>();
    if (!clip) return json({ error: "clip not found" }, 404);

    try {
      const store = await files();
      const keys = [clip.r2_key, clip.thumb_key].filter(Boolean) as string[];
      if (keys.length) await store.delete(keys);
    } catch {
      // Storage cleanup failure should not block removing the record.
    }

    await d.prepare("DELETE FROM clips WHERE id = ?").bind(id).run();
    return json({ ok: true, freedBytes: clip.bytes ?? 0 });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
