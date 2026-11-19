import { db, ensureClipStateColumns, env, getSettings } from "@/lib/db";
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
    await ensureClipStateColumns(d);
    const settings = await getSettings();
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 3), 10);

    const [spikes, pendingClips] = await Promise.all([
      d
        .prepare(
          // Re-cuts first: somebody asked for them, so they must not wait behind
          // a backlog of freshly detected moments.
          // The clip's kept footage travels with the spike: a re-cut of a live
          // moment is analysed from it when Twitch has no archive VOD yet.
          `SELECT s.*, c.title AS stream_title, c.game_name, c.display_name, c.avatar_url, c.capture_mode,
             cl.id AS clip_id, cl.source_key AS clip_source_key, cl.source_start_sec AS clip_source_start
           FROM spikes s JOIN channels c ON c.id = s.channel_id
           LEFT JOIN clips cl ON cl.spike_id = s.id
           WHERE s.status = 'queued' AND s.merged_into IS NULL
           ORDER BY (s.analyze_json IS NOT NULL) DESC, s.intensity DESC, s.ts_unix ASC LIMIT ?`,
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
             -- A clip whose moment is being re-analysed right now must not be
             -- rendered with the beat plan the analysis is about to replace.
             AND s.analyze_json IS NULL
           ORDER BY c.created_at ASC LIMIT ?`,
        )
        .bind(new Date(Date.now() - 3 * 60 * 1000).toISOString(), limit)
        .all<Clip>(),
    ]);

    // Ordered so the collector's startup cap keeps the channels that matter:
    // an unordered list meant which channels got dropped was arbitrary.
    const channels = await d
      .prepare(
        "SELECT * FROM channels WHERE monitor = 1 ORDER BY is_live DESC, viewer_count DESC, login ASC",
      )
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
