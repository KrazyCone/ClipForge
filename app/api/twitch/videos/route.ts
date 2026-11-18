import { appToken, twitchConfigured } from "@/lib/twitch";
import { isIngestAuthorized, json } from "@/lib/api";
import { db, env } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Archive VODs for one broadcaster, for the collector and renderer.
 *
 * The site holds the Twitch credentials, so GitHub Actions never needs a copy of
 * the client secret - it authenticates with INGEST_TOKEN instead and this route
 * performs the Helix call.
 */
export async function GET(req: Request) {
  if (!(await isIngestAuthorized(req))) return json({ error: "unauthorized" }, 401);

  const e = await env();
  if (!twitchConfigured(e)) return json({ error: "Twitch is not configured on the site" }, 503);

  const params = new URL(req.url).searchParams;
  const userId = (params.get("user_id") ?? "").trim();
  if (!/^\d{1,32}$/.test(userId)) return json({ error: "user_id must be a numeric Twitch id" }, 400);

  const requested = Number(params.get("first") ?? 20);
  const first = Math.min(50, Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : 20));

  try {
    const token = await appToken(e, await db());
    const res = await fetch(
      `https://api.twitch.tv/helix/videos?user_id=${userId}&type=archive&first=${first}`,
      { headers: { "Client-Id": e.TWITCH_CLIENT_ID!, Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      return json(
        { error: `helix videos ${res.status}`, detail: (await res.text()).slice(0, 200) },
        502,
      );
    }
    const data = (await res.json()) as { data?: unknown[] };
    return json({ videos: data.data ?? [] });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
}
