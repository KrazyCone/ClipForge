import { db, ensureAnalyzeColumn, ensureClipStateColumns } from "@/lib/db";
import { json } from "@/lib/api";
import type { Clip } from "@/lib/types";
import { denied } from "@/lib/guard";
import { ensureUniqueClipTitles } from "@/lib/queries";

export const dynamic = "force-dynamic";

const SORTS: Record<string, string> = {
  newest: "c.created_at DESC",
  recut: "c.recut_at DESC NULLS LAST, c.created_at DESC",
  quality: "c.quality_score DESC NULLS LAST, c.created_at DESC",
  funniest: "c.funniness DESC NULLS LAST, c.created_at DESC",
  intensity: "c.intensity DESC NULLS LAST, c.created_at DESC",
  duration: "c.duration_ms DESC NULLS LAST",
  streamer: "c.channel_name ASC, c.created_at DESC",
  game: "c.game_name ASC, c.created_at DESC",
};

export async function GET(req: Request) {
  const gate = await denied();
  if (gate) return gate;
  const url = new URL(req.url);
  const sort = SORTS[url.searchParams.get("sort") ?? "newest"] ?? SORTS.newest;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 60), 200);
  const status = url.searchParams.get("status");
  const channel = url.searchParams.get("channel");
  const spike = url.searchParams.get("spike");
  const recut = url.searchParams.get("recut");

  const where: string[] = [];
  const params: unknown[] = [];
  if (status && ["ready", "pending", "rendering", "failed"].includes(status)) {
    where.push("c.status = ?");
    params.push(status);
  }
  if (channel) {
    where.push("c.channel_login = ?");
    params.push(channel.toLowerCase());
  }
  if (spike) {
    where.push("c.spike_id = ?");
    params.push(spike);
  }
  if (recut === "1" || recut === "true") {
    where.push("c.recut_at IS NOT NULL");
  }

  try {
    const d = await db();
    await ensureAnalyzeColumn(d);
    await ensureClipStateColumns(d);
    // Older clips could share a generated title; name the later ones once.
    await ensureUniqueClipTitles();
    // rebuild_pending is derived from the source moment's one-off settings, so
    // the card can show a re-cut is waiting without hiding the current video.
    const sql = `SELECT c.*,
        (s.analyze_json IS NOT NULL AND s.status IN ('queued','analyzing','rendering'))
          AS rebuild_pending
      FROM clips c LEFT JOIN spikes s ON s.id = c.spike_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${sort} LIMIT ?`;
    const { results } = await d.prepare(sql).bind(...params, limit).all<Clip>();

    const facets = await d
      .prepare(
        `SELECT channel_login AS channel, game_name AS game, COUNT(*) AS n
         FROM clips WHERE status = 'ready' GROUP BY channel_login, game_name
         ORDER BY n DESC LIMIT 20`,
      )
      .all<{ channel: string; game: string; n: number }>();

    return json({ clips: results ?? [], facets: facets.results ?? [] });
  } catch (err) {
    return json({ clips: [], error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
