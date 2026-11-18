import { db, env } from "@/lib/db";
import { discoverLiveStreams, twitchConfigured } from "@/lib/twitch";
import { json } from "@/lib/api";
import { denied } from "@/lib/guard";

export const dynamic = "force-dynamic";

/** Live channels from Twitch's own /streams ordering (viewer count desc). */
export async function GET(req: Request) {
  const gate = await denied();
  if (gate) return gate;
  const e = await env();
  if (!twitchConfigured(e)) {
    return json(
      { error: "Twitch is not configured. Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.", streams: [] },
      503,
    );
  }

  const url = new URL(req.url);
  const first = Math.min(Number(url.searchParams.get("first") ?? 24), 60);
  const gameId = url.searchParams.get("game") ?? undefined;
  const language = url.searchParams.get("language") ?? undefined;

  try {
    const d = await db();
    const [streams, existing] = await Promise.all([
      discoverLiveStreams(e, { first, gameId, language }, d),
      d.prepare("SELECT id FROM channels").all<{ id: string }>(),
    ]);
    const monitored = new Set((existing.results ?? []).map((r) => r.id));
    return json({
      streams: streams.map((s) => ({
        id: s.user_id,
        login: s.user_login,
        displayName: s.user_name,
        title: s.title,
        game: s.game_name,
        viewers: s.viewer_count,
        language: s.language,
        startedAt: s.started_at,
        thumbnail: s.thumbnail_url?.replace("{width}", "320").replace("{height}", "180"),
        monitored: monitored.has(s.user_id),
      })),
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err), streams: [] }, 500);
  }
}
