import { db } from "@/lib/db";
import { json } from "@/lib/api";
import type { Spike } from "@/lib/types";
import { denied } from "@/lib/guard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await denied();
  if (gate) return gate;
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 25), 100);
  const channel = url.searchParams.get("channel");

  try {
    const d = await db();
    const { results } = channel
      ? await d
          .prepare(
            `SELECT * FROM spikes WHERE channel_login = ? AND merged_into IS NULL
             ORDER BY ts_unix DESC LIMIT ?`,
          )
          .bind(channel.toLowerCase(), limit)
          .all<Spike>()
      : await d
          .prepare("SELECT * FROM spikes WHERE merged_into IS NULL ORDER BY ts_unix DESC LIMIT ?")
          .bind(limit)
          .all<Spike>();

    return json({ spikes: results ?? [] });
  } catch (err) {
    return json({ spikes: [], error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
