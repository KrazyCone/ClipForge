import { db, env, getSettings } from "@/lib/db";
import { isIngestAuthorized, json } from "@/lib/api";
import type { Channel, Clip, Spike } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The renderer (running in a scheduled cloud job) polls this for work.
 * Returns spikes that still need analysis and clips that need rendering, plus
 * the settings it must honour - the server is the source of truth.
 */
export async function GET(req: Request) {
  if (!(await isIngestAuthorized(req))) return json({ error: "unauthorized" }, 401);

  try {
    const d = await db();
    const settings = await getSettings();
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 3), 10);

    const [spikes, pendingClips] = await Promise.all([
      d
        .prepare(
          `SELECT s.*, c.title AS stream_title, c.game_name, c.display_name, c.avatar_url, c.capture_mode
           FROM spikes s JOIN channels c ON c.id = s.channel_id
           WHERE s.status = 'queued' AND s.merged_into IS NULL
           ORDER BY s.intensity DESC, s.ts_unix ASC LIMIT ?`,
        )
        .bind(limit)
        .all<Spike & { stream_title: string; game_name: string; display_name: string; avatar_url: string; capture_mode: string }>(),
      // Ignore very fresh pending clips: the live path (running inside the
      // collector) is probably rendering them right now. Only pick up work the
      // live path abandoned or never attempted.
      d
        .prepare(
          `SELECT c.*, s.ai_json AS spike_ai_json
           FROM clips c LEFT JOIN spikes s ON s.id = c.spike_id
           WHERE c.status = 'pending' AND c.created_at < ?
           ORDER BY c.created_at ASC LIMIT ?`,
        )
        .bind(new Date(Date.now() - 3 * 60 * 1000).toISOString(), limit)
        .all<Clip>(),
    ]);

    const channels = await d
      .prepare("SELECT * FROM channels WHERE monitor = 1")
      .all<Channel>();

    return json({
      settings,
      spikes: spikes.results ?? [],
      clips: pendingClips.results ?? [],
      channels: (channels.results ?? []).map((c) => ({
        id: c.id,
        login: c.login,
        display_name: c.display_name,
        is_live: c.is_live,
        capture_mode: c.capture_mode,
      })),
      serverTime: new Date().toISOString(),
      aiConfigured: Boolean((await env()).CF_ACCOUNT_ID),
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
