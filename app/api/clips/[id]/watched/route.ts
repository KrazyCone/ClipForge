import { db, ensureClipStateColumns } from "@/lib/db";
import { json } from "@/lib/api";
import { denied } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * Marks a clip as watched. The card shows a "ready" badge until its clip has
 * been opened, so this is what clears it; the first view wins, because a later
 * one must not move the timestamp.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await denied();
  if (gate) return gate;
  const { id } = await ctx.params;

  try {
    const d = await db();
    await ensureClipStateColumns(d);
    const now = new Date().toISOString();
    await d
      .prepare("UPDATE clips SET watched_at = COALESCE(watched_at, ?) WHERE id = ?")
      .bind(now, id)
      .run();
    return json({ ok: true, watched_at: now });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
