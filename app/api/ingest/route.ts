import { db, env, getSettings } from "@/lib/db";
import { isIngestAuthorized, json, readJson } from "@/lib/api";
import { shouldMerge } from "@/lib/spike";
import type { SpikeFeatures } from "@/lib/spike";

export const dynamic = "force-dynamic";

interface IngestBody {
  login?: string;
  channelId?: string;
  minute?: {
    tsMinute: number;
    msgCount: number;
    uniqueChatters: number;
    emoteCount: number;
    repeatCount: number;
    capsRatio: number;
    emotes?: string[];
    buckets?: number[];
    samples?: string[];
  };
  spike?: {
    tsUnix: number;
    messageCount: number;
    baselineRate: number;
    peakRate: number;
    uniqueChatters: number;
    intensity: number;
    zScore: number;
    features: SpikeFeatures;
    samples: string[];
  };
  run?: { kind: string; status: string; detail?: string; finishedAt?: string };
}

const MAX_SAMPLES = 30;

function clampInt(n: unknown, lo: number, hi: number, fallback = 0): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

/**
 * Single write path for the cloud collector. Batches a minute of chat aggregates
 * plus any spike it detected. Everything is clamped so a buggy client cannot
 * blow through D1 storage.
 */
export async function POST(req: Request) {
  if (!(await isIngestAuthorized(req))) return json({ error: "unauthorized" }, 401);

  const body = await readJson<IngestBody>(req);
  if (!body?.login) return json({ error: "login is required" }, 400);

  const e = await env();
  try {
    const d = await db();
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    let writes = 0;

    // A run record describes the worker itself, not a channel. It used to be
    // rejected by the channel lookup below (the collector reports it with the
    // sentinel login "__run__", which is not a channel), so no run was ever
    // stored and the dashboard said the collector had never run.
    if (body.run) {
      statements.push(
        d
          .prepare(
            "INSERT INTO runs (id, kind, started_at, finished_at, status, detail) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(
            crypto.randomUUID(),
            String(body.run.kind).slice(0, 40),
            now,
            body.run.finishedAt ?? now,
            String(body.run.status).slice(0, 40),
            String(body.run.detail ?? "").slice(0, 500),
          ),
      );
      writes++;
    }

    const channel = await d
      .prepare("SELECT id, login, capture_mode, moments FROM channels WHERE login = ?")
      .bind(body.login.toLowerCase())
      .first<{ id: string; login: string; capture_mode: string; moments: number }>();

    if (!channel) {
      // A run-only payload is complete on its own; anything else still needs a
      // real channel to point at.
      if (!writes) return json({ error: `channel ${body.login} is not monitored` }, 404);
      await d.batch(statements);
      return json({ ok: true, run: true, writes });
    }

    const settings = await getSettings();

    if (body.minute) {
      const m = body.minute;
      const tsMinute = clampInt(m.tsMinute, 0, 4_000_000_000, Math.floor(Date.now() / 1000));
      const samples = (m.samples ?? []).slice(-MAX_SAMPLES).map((s) => String(s).slice(0, 180));
      statements.push(
        d
          .prepare(
            `INSERT INTO chat_minutes
              (channel_id, ts_minute, msg_count, unique_chatters, emote_count, repeat_count,
               caps_ratio, emotes_json, buckets_json, samples_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(channel_id, ts_minute) DO UPDATE SET
               msg_count = excluded.msg_count,
               unique_chatters = excluded.unique_chatters,
               emote_count = excluded.emote_count,
               repeat_count = excluded.repeat_count,
               caps_ratio = excluded.caps_ratio,
               emotes_json = excluded.emotes_json,
               buckets_json = excluded.buckets_json,
               samples_json = excluded.samples_json`,
          )
          .bind(
            channel.id,
            tsMinute,
            clampInt(m.msgCount, 0, 100000),
            clampInt(m.uniqueChatters, 0, 100000),
            clampInt(m.emoteCount, 0, 100000),
            clampInt(m.repeatCount, 0, 100000),
            Math.min(1, Math.max(0, Number(m.capsRatio) || 0)),
            JSON.stringify((m.emotes ?? []).slice(0, 8)),
            JSON.stringify((m.buckets ?? []).slice(0, 12).map((n) => clampInt(n, 0, 10000))),
            JSON.stringify(samples),
          ),
      );
      writes++;
    }

    let spikeId: string | null = null;
    let merged = false;

    if (body.spike) {
      const s = body.spike;
      const ts = clampInt(s.tsUnix, 0, 4_000_000_000, Math.floor(Date.now() / 1000));
      const intensity = Math.min(100, Math.max(0, Number(s.intensity) || 0));

      const existing = await d
        .prepare(
          `SELECT id, intensity FROM spikes
           WHERE channel_id = ? AND merged_into IS NULL AND ts_unix BETWEEN ? AND ?
           ORDER BY ABS(ts_unix - ?) ASC LIMIT 1`,
        )
        .bind(channel.id, ts - 90, ts + 90, ts)
        .first<{ id: string; intensity: number }>();

      if (existing && shouldMerge(ts, ts, intensity, existing.intensity, 90)) {
        merged = true;
        spikeId = existing.id;
        if (intensity > existing.intensity) {
          statements.push(
            d
              .prepare("UPDATE spikes SET intensity = ?, peak_rate = MAX(peak_rate, ?) WHERE id = ?")
              .bind(intensity, Number(s.peakRate) || 0, existing.id),
          );
          writes++;
        }
      } else {
        spikeId = crypto.randomUUID();
        const autoProcess = settings.autoProcess && channel.capture_mode !== "none";
        statements.push(
          d
            .prepare(
              `INSERT INTO spikes
                (id, channel_id, channel_login, detected_at, ts_unix, message_count, baseline_rate,
                 peak_rate, unique_chatters, intensity, z_score, features_json, samples_json,
                 status, ai_json, ai_provider, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
            )
            .bind(
              spikeId,
              channel.id,
              channel.login,
              now,
              ts,
              clampInt(s.messageCount, 0, 100000),
              Number(s.baselineRate) || 0,
              Number(s.peakRate) || 0,
              clampInt(s.uniqueChatters, 0, 100000),
              intensity,
              Number(s.zScore) || 0,
              JSON.stringify(s.features ?? {}),
              JSON.stringify((s.samples ?? []).slice(0, MAX_SAMPLES).map((x) => String(x).slice(0, 180))),
              autoProcess ? "queued" : "paused",
              now,
            ),
        );
        statements.push(
          d.prepare("UPDATE channels SET moments = moments + 1 WHERE id = ?").bind(channel.id),
        );
        writes += 2;
      }
    }

    if (statements.length) await d.batch(statements);

    // No usage_log row here on purpose: it would double the per-minute write
    // cost of every monitored channel, and the dashboard derives its quota
    // meters from real row counts rather than this table.
    return json({ ok: true, spikeId, merged, writes });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
