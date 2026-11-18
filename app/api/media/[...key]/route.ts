import { files } from "@/lib/db";
import { denied } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * Authenticated-by-obscurity media proxy. R2 is not public; the dashboard plays
 * clips through this route. Supports HTTP Range so <video> can seek.
 */
export async function GET(req: Request, ctx: { params: Promise<{ key: string[] }> }) {
  const gate = await denied();
  if (gate) return gate;
  const { key } = await ctx.params;
  const path = key.join("/");
  if (!/^[a-zA-Z0-9._/-]+$/.test(path) || path.includes("..")) {
    return new Response("bad key", { status: 400 });
  }

  try {
    const store = await files();
    const range = req.headers.get("range");
    let object: R2ObjectBody | null;

    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      if (match) {
        const offset = Number(match[1]);
        const length = match[2] ? Number(match[2]) - offset + 1 : undefined;
        object = await store.get(path, { range: { offset, length } });
        if (!object) return new Response("not found", { status: 404 });
        return new Response(object.body, {
          status: 206,
          headers: {
            "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
            "content-range": `bytes ${offset}-${offset + object.size - 1}`,
            "accept-ranges": "bytes",
            "content-length": String(object.size),
            "cache-control": "public, max-age=86400",
          },
        });
      }
    }

    object = await store.get(path);
    if (!object) return new Response("not found", { status: 404 });
    return new Response(object.body, {
      headers: {
        "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "content-length": String(object.size),
        "accept-ranges": "bytes",
        "cache-control": "public, max-age=86400",
        etag: object.httpEtag ?? "",
      },
    });
  } catch (err) {
    return new Response(String(err), { status: 500 });
  }
}
