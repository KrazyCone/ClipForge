import { db } from "@/lib/db";
import { json } from "@/lib/api";
import type { Clip } from "@/lib/types";
import { denied } from "@/lib/guard";

export const dynamic = "force-dynamic";

const SORTS: Record<string, string> = {
  newest: "created_at DESC",
  quality: "quality_score DESC NULLS LAST, created_at DESC",
  funniest: "funniness DESC NULLS LAST, created_at DESC",
  intensity: "intensity DESC NULLS LAST, created_at DESC",
  duration: "duration_ms DESC NULLS LAST",
  streamer: "channel_name ASC, created_at DESC",
  game: "game_name ASC, created_at DESC",
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

  const where: string[] = [];
  const params: unknown[] = [];
  if (status && ["ready", "pending", "rendering", "failed"].includes(status)) {
    where.push("status = ?");
    params.push(status);
  }
  if (channel) {
    where.push("channel_login = ?");
    params.push(channel.toLowerCase());
  }
  if (spike) {
    where.push("spike_id = ?");
    params.push(spike);
  }

  try {
    const d = await db();
    const sql = `SELECT * FROM clips ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${sort} LIMIT ?`;
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
