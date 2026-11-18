import { db } from "@/lib/db";
import { isIngestAuthorized, json, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Renderer-only endpoint: mark a clip failed (or back to pending) with a reason. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isIngestAuthorized(req))) return json({ error: "unauthorized" }, 401);
  const { id } = await ctx.params;
  const body = await readJson<{ status?: string; error?: string }>(req);
  if (!body?.status || !["pending", "rendering", "failed", "ready"].includes(body.status)) {
    return json({ error: "invalid status" }, 400);
  }

  try {
    const d = await db();
    await d
      .prepare("UPDATE clips SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .bind(body.status, body.error?.slice(0, 500) ?? null, new Date().toISOString(), id)
      .run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
