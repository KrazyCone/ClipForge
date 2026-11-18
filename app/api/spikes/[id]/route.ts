import { db } from "@/lib/db";
import { isIngestAuthorized, json, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

const STATUSES = ["queued", "paused", "analyzing", "rendering", "done", "failed", "skipped"];

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isIngestAuthorized(req))) return json({ error: "unauthorized" }, 401);
  const { id } = await ctx.params;
  const body = await readJson<{ status?: string; error?: string }>(req);
  if (!body?.status || !STATUSES.includes(body.status)) {
    return json({ error: `status must be one of ${STATUSES.join(", ")}` }, 400);
  }

  try {
    const d = await db();
    await d.prepare("UPDATE spikes SET status = ? WHERE id = ?").bind(body.status, id).run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
