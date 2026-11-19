import { files } from "@/lib/db";
import { denied } from "@/lib/guard";
import { parseRange, resolveRange } from "@/lib/range";

export const dynamic = "force-dynamic";

/**
 * Media proxy. R2 is not public; the dashboard plays clips through this route.
 *
 * Range support is what makes `<video>` work at all: it needs 206 responses
 * whose `content-length` matches the bytes actually sent and whose
 * `content-range` is relative to the whole object. Reporting the object's full
 * size on a partial body makes the player wait for bytes that never arrive.
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
    const head = await store.head(path);
    if (!head) return new Response("not found", { status: 404 });

    const headers = new Headers({
      "content-type": head.httpMetadata?.contentType ?? "application/octet-stream",
      "accept-ranges": "bytes",
      // The route is gated per user, so a shared cache must never hold it. It
      // revalidates on every play as well: a re-rendered clip must not be
      // served from a stale entry, or the old cut keeps playing.
      "cache-control": "private, max-age=0, must-revalidate",
      etag: head.httpEtag ?? "",
    });

    const requested = parseRange(req.headers.get("range"));
    const range = requested ? resolveRange(requested, head.size) : null;

    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${head.size}`, "accept-ranges": "bytes" },
      });
    }

    if (!range) {
      headers.set("content-length", String(head.size));
      const object = await store.get(path);
      if (!object) return new Response("not found", { status: 404 });
      return new Response(object.body, { headers });
    }

    const object = await store.get(path, {
      range: { offset: range.start, length: range.length },
    });
    if (!object) return new Response("not found", { status: 404 });

    headers.set(
      "content-range",
      `bytes ${range.start}-${range.start + range.length - 1}/${head.size}`,
    );
    headers.set("content-length", String(range.length));
    return new Response(object.body, { status: 206, headers });
  } catch (err) {
    return new Response(String(err), { status: 500 });
  }
}

export async function HEAD(req: Request, ctx: { params: Promise<{ key: string[] }> }) {
  const gate = await denied();
  if (gate) return new Response(null, { status: 401 });

  const { key } = await ctx.params;
  const path = key.join("/");
  if (!/^[a-zA-Z0-9._/-]+$/.test(path) || path.includes("..")) {
    return new Response(null, { status: 400 });
  }

  try {
    const store = await files();
    const head = await store.head(path);
    if (!head) return new Response(null, { status: 404 });
    return new Response(null, {
      headers: {
        "content-type": head.httpMetadata?.contentType ?? "application/octet-stream",
        "accept-ranges": "bytes",
        "content-length": String(head.size),
        etag: head.httpEtag ?? "",
      },
    });
  } catch {
    return new Response(null, { status: 500 });
  }
}
