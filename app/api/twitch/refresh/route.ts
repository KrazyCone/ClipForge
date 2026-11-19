import { db, env } from "@/lib/db";
import { streamsForUsers, twitchConfigured } from "@/lib/twitch";
import { json } from "@/lib/api";
import type { Channel } from "@/lib/types";
import { denied } from "@/lib/guard";
import { isIngestAuthorized } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Polls Twitch for the live state of every monitored channel in one batched
 * Helix call (up to 100 ids per request), and prunes chat history older than 26h.
 */
export async function POST(req: Request) {
  // Callable by the signed-in operator and by the collector (bearer token),
  // which needs live status to decide which channels to buffer.
  const gate = await denied();
  if (gate && !(await isIngestAuthorized(req))) return gate;
  const e = await env();
  if (!twitchConfigured(e)) {
    return json({ error: "Twitch is not configured (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET)." }, 503);
  }

  try {
    const d = await db();
    const { results } = await d
      .prepare("SELECT * FROM channels WHERE monitor = 1")
      .all<Channel>();
    const channels = results ?? [];
    if (channels.length === 0) return json({ updated: 0, live: 0, channels: [] });

    const streams = await streamsForUsers(e, channels.map((c) => c.id), d);
    const byId = new Map(streams.map((s) => [s.user_id, s]));
    const now = new Date().toISOString();

    const statements = channels.map((c) => {
      const s = byId.get(c.id);
      if (s) {
        return d
          .prepare(
            `UPDATE channels SET is_live = 1, title = ?, game_name = ?, game_id = ?,
               viewer_count = ?, started_at = ?, last_live_at = ?, last_polled_at = ?
             WHERE id = ?`,
          )
          .bind(
            s.title,
            s.game_name,
            s.game_id,
            s.viewer_count,
            s.started_at,
            now,
            now,
            c.id,
          );
      }
      return d
        .prepare(
          "UPDATE channels SET is_live = 0, viewer_count = NULL, last_polled_at = ? WHERE id = ?",
        )
        .bind(now, c.id);
    });

    // Retention: the live graph only needs recent history, and D1 storage is 100 MB.
    const cutoff = Math.floor(Date.now() / 1000) - 26 * 3600;
    statements.push(d.prepare("DELETE FROM chat_minutes WHERE ts_minute < ?").bind(cutoff));
    // The collector now writes a run row on every heartbeat, so old ones go too.
    statements.push(
      d
        .prepare("DELETE FROM runs WHERE started_at < ?")
        .bind(new Date(Date.now() - 7 * 86_400_000).toISOString()),
    );

    await d.batch(statements);

    const latest = await d
      .prepare("SELECT * FROM channels WHERE monitor = 1 ORDER BY is_live DESC, viewer_count DESC")
      .all<Channel>();

    return json({
      updated: channels.length,
      live: (latest.results ?? []).filter((c) => c.is_live === 1).length,
      channels: latest.results ?? [],
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
