import { db, ensureClipStateColumns, files } from "@/lib/db";
import { isIngestAuthorized, json } from "@/lib/api";
import type { Clip } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The footage window a clip was cut from.
 *
 * Twitch publishes an archive VOD only after a stream ends, so a re-cut of a
 * moment from a stream that is still live had nothing to cut from and sat
 * queued for hours or days. The renderer now keeps the few seconds it actually
 * used, which makes every re-cut independent of Twitch.
 */
const MAX_BYTES = 60 * 1024 * 1024;

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isIngestAuthorized(req))) return json({ error: "unauthorized" }, 401);
  const { id } = await ctx.params;

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) {
    return json({ error: `source too large (${(declared / 1048576).toFixed(0)} MB)` }, 413);
  }

  try {
    const body = await req.arrayBuffer();
    if (!body.byteLength) return json({ error: "empty source" }, 400);
    if (body.byteLength > MAX_BYTES) return json({ error: "source too large" }, 413);

    const d = await db();
    await ensureClipStateColumns(d);
    const clip = await d.prepare("SELECT * FROM clips WHERE id = ?").bind(id).first<Clip>();
    if (!clip) return json({ error: "clip not found" }, 404);

    const startSec = Number(new URL(req.url).searchParams.get("startSec"));
    const store = await files();
    const key = `sources/${id}.ts`;
    await store.put(key, body, {
      httpMetadata: { contentType: "video/mp2t" },
    });

    await d
      .prepare(
        "UPDATE clips SET source_key = ?, source_start_sec = ?, updated_at = ? WHERE id = ?",
      )
      .bind(key, Number.isFinite(startSec) ? startSec : null, new Date().toISOString(), id)
      .run();

    return json({ ok: true, key, bytes: body.byteLength });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/** Machine read of the same object: the renderer downloads it to re-cut. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isIngestAuthorized(_req))) return json({ error: "unauthorized" }, 401);
  const { id } = await ctx.params;

  try {
    const d = await db();
    await ensureClipStateColumns(d);
    const clip = await d
      .prepare("SELECT source_key FROM clips WHERE id = ?")
      .bind(id)
      .first<{ source_key: string | null }>();
    if (!clip?.source_key) return json({ error: "no source stored for this clip" }, 404);

    const store = await files();
    const object = await store.get(clip.source_key);
    if (!object) return json({ error: "source missing" }, 404);

    return new Response(object.body, {
      headers: {
        "content-type": object.httpMetadata?.contentType ?? "video/mp2t",
        "content-length": String(object.size),
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
