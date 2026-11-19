import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AppSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import type { ClipFeedback } from "./feedback";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
  INGEST_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_AI_TOKEN?: string;
  AI_MODEL?: string;
  VISION_MODEL?: string;
  STT_MODEL?: string;
  APP_ORIGIN?: string;
  FREEBUFF_CLIENT_ID?: string;
  FREEBUFF_ISSUER?: string;
  /** optional: lets a re-cut start a renderer run instead of waiting for one */
  GITHUB_DISPATCH_TOKEN?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_DISPATCH_REF?: string;
}

export async function env(): Promise<Env> {
  const { env: cfEnv } = await getCloudflareContext({ async: true });
  return cfEnv as unknown as Env;
}

export async function db(): Promise<D1Database> {
  const e = await env();
  if (!e?.DB) throw new Error("D1 binding DB is not available in this environment.");
  return e.DB;
}

export async function files(): Promise<R2Bucket> {
  const e = await env();
  if (!e?.FILES) throw new Error("R2 binding FILES is not available in this environment.");
  return e.FILES;
}

let feedbackTable: Promise<void> | null = null;

/**
 * The feedback table ships in db/schema.sql, but an already-initialised D1
 * database does not pick new DDL up on deploy. Creating it lazily keeps the
 * likes/dislikes working without asking anyone to re-run /api/setup.
 */
export function ensureFeedbackTable(d: D1Database): Promise<void> {
  if (!feedbackTable) {
    feedbackTable = d
      .batch([
        d.prepare(
          `CREATE TABLE IF NOT EXISTS clip_feedback (
             clip_id      TEXT PRIMARY KEY,
             sentiment    TEXT NOT NULL,
             reasons_json TEXT,
             note         TEXT,
             quality_at   INTEGER,
             created_at   TEXT NOT NULL,
             updated_at   TEXT NOT NULL
           )`,
        ),
        d.prepare(
          "CREATE INDEX IF NOT EXISTS idx_clip_feedback_sentiment ON clip_feedback(sentiment)",
        ),
      ])
      .then(() => undefined)
      .catch((err) => {
        feedbackTable = null;
        throw err;
      });
  }
  return feedbackTable;
}

let webcamColumn: Promise<void> | null = null;

/** The webcam crop column ships in db/schema.sql; a live database needs the ALTER. */
export function ensureWebcamColumn(d: D1Database): Promise<void> {
  if (!webcamColumn) {
    webcamColumn = d
      .prepare("ALTER TABLE clips ADD COLUMN webcam_json TEXT")
      .run()
      .then(() => undefined)
      .catch(() => undefined);
  }
  return webcamColumn;
}

let analyzeColumn: Promise<void> | null = null;

/**
 * Single-clip rebuilds store their settings on the spike. The column ships in
 * db/schema.sql, but a live database needs the ALTER; a duplicate-column error
 * just means it is already there.
 */
export function ensureAnalyzeColumn(d: D1Database): Promise<void> {
  if (!analyzeColumn) {
    analyzeColumn = d
      .prepare("ALTER TABLE spikes ADD COLUMN analyze_json TEXT")
      .run()
      .then(() => undefined)
      .catch(() => undefined);
  }
  return analyzeColumn;
}

/** Read a single setting, falling back to the default when unset. */
export async function getSettings(): Promise<AppSettings> {
  try {
    const d = await db();
    const { results } = await d
      .prepare("SELECT key, value FROM settings")
      .all<{ key: string; value: string }>();
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const row of results ?? []) {
      const def = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[row.key];
      if (def === undefined) continue;
      out[row.key] =
        typeof def === "boolean"
          ? row.value === "true"
          : typeof def === "number"
            ? Number(row.value)
            : row.value;
    }
    return out as unknown as AppSettings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Record<string, unknown>): Promise<void> {
  const d = await db();
  const statements = Object.entries(patch)
    .filter(([k]) => k in DEFAULT_SETTINGS)
    .map(([k, v]) =>
      d
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(k, String(v)),
    );
  if (statements.length) await d.batch(statements);
}

/** Record a usage event (used for the free-quota meters in the UI). */
export async function logUsage(kind: string, amount: number, meta?: string): Promise<void> {
  try {
    const d = await db();
    await d
      .prepare("INSERT INTO usage_log (id, ts, kind, amount, meta) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), Math.floor(Date.now() / 1000), kind, amount, meta ?? null)
      .run();
  } catch {
    // usage logging must never break a request
  }
}

export async function usageTotals(sinceSec: number): Promise<Record<string, number>> {
  const d = await db();
  const { results } = await d
    .prepare("SELECT kind, SUM(amount) AS total FROM usage_log WHERE ts >= ? GROUP BY kind")
    .bind(sinceSec)
    .all<{ kind: string; total: number }>();
  const out: Record<string, number> = {};
  for (const r of results ?? []) out[r.kind] = r.total ?? 0;
  return out;
}
