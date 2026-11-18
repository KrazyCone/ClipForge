import { db, files } from "@/lib/db";
import { isIngestAuthorized, json } from "@/lib/api";
import type { Clip } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_BYTES = 40 * 1024 * 1024;

/**
 * Receives a rendered MP4 (and optional JPEG thumbnail) from the renderer and
 * stores it in R2. Rejects anything that would blow the free storage budget.
 */
export async function POST(req: Request) {
  if (!(await isIngestAuthorized(req))) return json({ error: "unauthorized" }, 401);

  try {
    const form = await req.formData();
    const clipId = String(form.get("clipId") ?? "");
    const file = form.get("file");
    const thumb = form.get("thumb");

    if (!clipId) return json({ error: "clipId is required" }, 400);
    if (!(file instanceof File)) return json({ error: "file is required" }, 400);
    if (file.size > MAX_BYTES) {
      return json({ error: `file too large (${(file.size / 1048576).toFixed(1)} MB, max 40 MB)` }, 413);
    }

    const d = await db();
    const clip = await d.prepare("SELECT * FROM clips WHERE id = ?").bind(clipId).first<Clip>();
    if (!clip) return json({ error: "clip not found" }, 404);

    const store = await files();
    const mp4Key = `clips/${clipId}.mp4`;
    await store.put(mp4Key, await file.arrayBuffer(), {
      httpMetadata: { contentType: "video/mp4", cacheControl: "public, max-age=31536000" },
    });

    let thumbKey: string | null = null;
    if (thumb instanceof File && thumb.size > 0) {
      thumbKey = `clips/${clipId}.jpg`;
      await store.put(thumbKey, await thumb.arrayBuffer(), {
        httpMetadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000" },
      });
    }

    const meta = JSON.parse(String(form.get("meta") ?? "{}")) as {
      durationMs?: number;
      width?: number;
      height?: number;
      provider?: string;
      model?: string;
    };

    await d
      .prepare(
        `UPDATE clips SET r2_key = ?, thumb_key = ?, bytes = ?, status = 'ready', error = NULL,
           duration_ms = COALESCE(?, duration_ms), width = COALESCE(?, width),
           height = COALESCE(?, height), provider = COALESCE(?, provider),
           model = COALESCE(?, model), updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        mp4Key,
        thumbKey,
        file.size,
        meta.durationMs ?? null,
        meta.width ?? null,
        meta.height ?? null,
        meta.provider ?? null,
        meta.model ?? null,
        new Date().toISOString(),
        clipId,
      )
      .run();

    if (clip.spike_id) {
      await d.prepare("UPDATE spikes SET status = 'done' WHERE id = ?").bind(clip.spike_id).run();
    }

    return json({ ok: true, clipId, bytes: file.size, thumbKey, mediaUrl: `/api/media/${mp4Key}` });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
