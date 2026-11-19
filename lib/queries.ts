import { db, ensureAnalyzeColumn, ensureFeedbackTable, usageTotals } from "./db";
import type { Channel, Clip, Spike } from "./types";
import type { ClipFeedback } from "./feedback";
import { uniqueTitleChanges } from "./titles";

export async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function getChannels(): Promise<Channel[]> {
  return safe(async () => {
    const d = await db();
    const { results } = await d
      .prepare("SELECT * FROM channels WHERE monitor = 1 ORDER BY is_live DESC, viewer_count DESC, login ASC")
      .all<Channel>();
    return results ?? [];
  }, []);
}

export async function getAllChannels(): Promise<Channel[]> {
  return safe(async () => {
    const d = await db();
    const { results } = await d
      .prepare("SELECT * FROM channels ORDER BY monitor DESC, is_live DESC, login ASC")
      .all<Channel>();
    return results ?? [];
  }, []);
}

/**
 * Repairs clips that ended up with the same title. The first (oldest) keeps it
 * and every later duplicate is renamed, so this is a one-time change that turns
 * into a cheap no-op once the table is unique.
 */
export async function ensureUniqueClipTitles(): Promise<void> {
  try {
    const d = await db();
    const { results } = await d
      .prepare("SELECT id, title FROM clips ORDER BY created_at ASC, id ASC")
      .all<{ id: string; title: string | null }>();
    for (const change of uniqueTitleChanges(results ?? [])) {
      await d.prepare("UPDATE clips SET title = ? WHERE id = ?").bind(change.title, change.id).run();
    }
  } catch {
    /* a cosmetic repair must never break the library */
  }
}

export async function getRecentClips(limit = 12): Promise<Clip[]> {
  return safe(async () => {
    const d = await db();
    await ensureAnalyzeColumn(d);
    await ensureUniqueClipTitles();
    const { results } = await d
      .prepare(
        `SELECT c.*,
           (s.analyze_json IS NOT NULL AND s.status IN ('queued','analyzing','rendering'))
             AS rebuild_pending
         FROM clips c LEFT JOIN spikes s ON s.id = c.spike_id
         ORDER BY c.created_at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<Clip>();
    return results ?? [];
  }, []);
}

export async function getTopClips(limit = 6): Promise<Clip[]> {
  return safe(async () => {
    const d = await db();
    const { results } = await d
      .prepare("SELECT * FROM clips WHERE status = 'ready' ORDER BY quality_score DESC, created_at DESC LIMIT ?")
      .bind(limit)
      .all<Clip>();
    return results ?? [];
  }, []);
}

export async function getAllFeedback(): Promise<ClipFeedback[]> {
  return safe(async () => {
    const d = await db();
    await ensureFeedbackTable(d);
    const { results } = await d
      .prepare("SELECT * FROM clip_feedback ORDER BY updated_at DESC")
      .all<ClipFeedback>();
    return results ?? [];
  }, []);
}

export async function getRecentSpikes(limit = 20): Promise<Spike[]> {
  return safe(async () => {
    const d = await db();
    const { results } = await d
      .prepare("SELECT * FROM spikes WHERE merged_into IS NULL ORDER BY ts_unix DESC LIMIT ?")
      .bind(limit)
      .all<Spike>();
    return results ?? [];
  }, []);
}

export async function getSpikesForChannel(channelId: string, limit = 6): Promise<Spike[]> {
  return safe(async () => {
    const d = await db();
    const { results } = await d
      .prepare("SELECT * FROM spikes WHERE channel_id = ? AND merged_into IS NULL ORDER BY ts_unix DESC LIMIT ?")
      .bind(channelId, limit)
      .all<Spike>();
    return results ?? [];
  }, []);
}

export interface Stats {
  clips: number;
  readyClips: number;
  spikesToday: number;
  spikesTotal: number;
  liveChannels: number;
  channelCount: number;
  queueDepth: number;
  avgQuality: number | null;
  storageBytes: number;
  d1Rows: number;
  writesToday: number;
}

export async function getStats(): Promise<Stats> {
  const midnight = Math.floor(Date.now() / 1000 / 86400) * 86400;
  return safe(async () => {
    const d = await db();
    const [clips, ready, spikesToday, spikesTotal, live, channels, queue, avg, storage, rows, usage] =
      await Promise.all([
        d.prepare("SELECT COUNT(*) AS n FROM clips").first<{ n: number }>(),
        d.prepare("SELECT COUNT(*) AS n FROM clips WHERE status = 'ready'").first<{ n: number }>(),
        d.prepare("SELECT COUNT(*) AS n FROM spikes WHERE ts_unix >= ?").bind(midnight).first<{ n: number }>(),
        d.prepare("SELECT COUNT(*) AS n FROM spikes").first<{ n: number }>(),
        d.prepare("SELECT COUNT(*) AS n FROM channels WHERE is_live = 1 AND monitor = 1").first<{ n: number }>(),
        d.prepare("SELECT COUNT(*) AS n FROM channels").first<{ n: number }>(),
        d.prepare("SELECT COUNT(*) AS n FROM clips WHERE status IN ('pending','rendering')").first<{ n: number }>(),
        d.prepare("SELECT AVG(quality_score) AS a FROM clips WHERE status = 'ready'").first<{ a: number | null }>(),
        d.prepare("SELECT SUM(bytes) AS b FROM clips").first<{ b: number | null }>(),
        d.prepare(
          "SELECT (SELECT COUNT(*) FROM chat_minutes) + (SELECT COUNT(*) FROM spikes) + (SELECT COUNT(*) FROM clips) AS n",
        ).first<{ n: number }>(),
        d
          .prepare(
            "SELECT (SELECT COUNT(*) FROM chat_minutes WHERE ts_minute >= ?) + (SELECT COUNT(*) FROM spikes WHERE ts_unix >= ?) + (SELECT COUNT(*) FROM clips WHERE created_at >= ?) AS n",
          )
          .bind(midnight, midnight, new Date(midnight * 1000).toISOString())
          .first<{ n: number }>(),
      ]);

    return {
      clips: clips?.n ?? 0,
      readyClips: ready?.n ?? 0,
      spikesToday: spikesToday?.n ?? 0,
      spikesTotal: spikesTotal?.n ?? 0,
      liveChannels: live?.n ?? 0,
      channelCount: channels?.n ?? 0,
      queueDepth: queue?.n ?? 0,
      avgQuality: avg?.a ? Math.round(avg.a) : null,
      storageBytes: storage?.b ?? 0,
      d1Rows: rows?.n ?? 0,
      writesToday: usage?.n ?? 0,
    };
  }, {
    clips: 0, readyClips: 0, spikesToday: 0, spikesTotal: 0, liveChannels: 0,
    channelCount: 0, queueDepth: 0, avgQuality: null, storageBytes: 0, d1Rows: 0, writesToday: 0,
  });
}

/** Per-channel 5s activity series for the last `minutes`, rebuilt from chat_minutes. */
export async function getActivitySeries(
  channelIds: string[],
  minutes = 20,
): Promise<Record<string, number[]>> {
  if (channelIds.length === 0) return {};
  const cutoff = Math.floor(Date.now() / 1000) - minutes * 60;
  return safe(async () => {
    const d = await db();
    const placeholders = channelIds.map(() => "?").join(",");
    const { results } = await d
      .prepare(
        `SELECT channel_id, buckets_json FROM chat_minutes
         WHERE ts_minute >= ? AND channel_id IN (${placeholders})
         ORDER BY ts_minute ASC`,
      )
      .bind(cutoff, ...channelIds)
      .all<{ channel_id: string; buckets_json: string | null }>();

    const out: Record<string, number[]> = {};
    for (const id of channelIds) out[id] = [];
    for (const row of results ?? []) {
      if (!row.buckets_json) continue;
      try {
        const buckets = JSON.parse(row.buckets_json) as number[];
        out[row.channel_id] = out[row.channel_id].concat(buckets);
      } catch {
        /* ignore malformed rows */
      }
    }
    for (const id of channelIds) {
      const series = out[id];
      out[id] = series.length > 240 ? series.slice(-240) : series;
    }
    return out;
  }, {});
}

export async function getChatSamples(
  channelId: string,
  limit = 12,
): Promise<{ ts: number; messages: string[] } | null> {
  return safe(async () => {
    const d = await db();
    const row = await d
      .prepare("SELECT ts_minute, samples_json FROM chat_minutes WHERE channel_id = ? ORDER BY ts_minute DESC LIMIT 1")
      .bind(channelId)
      .first<{ ts_minute: number; samples_json: string | null }>();
    if (!row?.samples_json) return null;
    return { ts: row.ts_minute, messages: JSON.parse(row.samples_json) as string[] };
  }, null);
}

export async function getDailyUsage(): Promise<Record<string, number>> {
  const midnight = Math.floor(Date.now() / 1000 / 86400) * 86400;
  return safe(() => usageTotals(midnight), {});
}

export async function getLastRun(
  kind: string,
): Promise<{ started_at: string; status: string; detail: string | null } | null> {
  return safe(async () => {
    const d = await db();
    return await d
      .prepare(
        "SELECT started_at, status, detail FROM runs WHERE kind = ? ORDER BY started_at DESC LIMIT 1",
      )
      .bind(kind)
      .first<{ started_at: string; status: string; detail: string | null }>();
  }, null);
}
