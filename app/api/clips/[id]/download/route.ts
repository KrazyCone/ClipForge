import { db, files } from "@/lib/db";
import type { Clip } from "@/lib/types";
import { denied } from "@/lib/guard";

export const dynamic = "force-dynamic";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await denied();
  if (gate) return gate;
  const { id } = await ctx.params;
  try {
    const d = await db();
    const clip = await d.prepare("SELECT * FROM clips WHERE id = ?").bind(id).first<Clip>();
    if (!clip?.r2_key) return new Response("clip not found", { status: 404 });

    const store = await files();
    const object = await store.get(clip.r2_key);
    if (!object) return new Response("object missing from storage", { status: 404 });

    const filename = `${slug(clip.channel_name ?? "clipforge")}-${slug(clip.caption ?? clip.title ?? "clip")}.mp4`;
    return new Response(object.body, {
      headers: {
        "content-type": "video/mp4",
        "content-length": String(object.size),
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "private, max-age=3600",
      },
    });
  } catch (err) {
    return new Response(String(err), { status: 500 });
  }
}
