import { db, files } from "@/lib/db";
import { json, readJson } from "@/lib/api";
import type { Clip } from "@/lib/types";
import { denied } from "@/lib/guard";

export const dynamic = "force-dynamic";

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
      try {
        const store = await files();
        const keys = [clip.r2_key, clip.thumb_key].filter(Boolean) as string[];
        if (keys.length) await store.delete(keys);
      } catch {
        /* asset may not exist */
      }
      await d
        .prepare(
          "UPDATE clips SET status = 'pending', r2_key = NULL, thumb_key = NULL, bytes = NULL, error = NULL, updated_at = ? WHERE id = ?",
        )
        .bind(new Date().toISOString(), id)
        .run();
      if (clip.spike_id) {
        await d.prepare("UPDATE spikes SET status = 'rendering' WHERE id = ?").bind(clip.spike_id).run();
      }
      return json({ ok: true, queued: true });
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
    sets.push("updated_at = ?");
    values.push(new Date().toISOString(), id);
    await d.prepare(`UPDATE clips SET ${sets.join(", ")} WHERE id = ?`).bind(...values).run();
    return json({ ok: true });
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
