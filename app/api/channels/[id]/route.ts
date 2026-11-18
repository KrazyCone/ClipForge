import { db } from "@/lib/db";
import { json, readJson } from "@/lib/api";
import { denied } from "@/lib/guard";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await denied();
  if (gate) return gate;
  const { id } = await ctx.params;
  const body = await readJson<{ monitor?: boolean }>(req);
  if (typeof body?.monitor !== "boolean") return json({ error: "monitor must be a boolean" }, 400);
  try {
    const d = await db();
    await d
      .prepare("UPDATE channels SET monitor = ? WHERE id = ?")
      .bind(body.monitor ? 1 : 0, id)
      .run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

/**
 * Removes the channel and its chat history. Clips that already exist are kept -
 * they are finished assets and removing a channel should not delete them.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await denied();
  if (gate) return gate;
  const { id } = await ctx.params;
  try {
    const d = await db();
    await d.batch([
      d.prepare("DELETE FROM chat_minutes WHERE channel_id = ?").bind(id),
      d.prepare("DELETE FROM channels WHERE id = ?").bind(id),
    ]);
    return json({ ok: true });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
