import { db, env } from "@/lib/db";
import { SCHEMA_SQL } from "@/lib/schema";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { isIngestAuthorized, json } from "@/lib/api";

export const dynamic = "force-dynamic";

/** GET reports whether the schema is present. */
export async function GET() {
  try {
    const d = await db();
    const row = await d
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'clips'")
      .first<{ n: number }>();
    return json({ initialized: (row?.n ?? 0) > 0 });
  } catch (err) {
    return json({ initialized: false, error: String(err) });
  }
}

/**
 * Idempotent schema creation. DDL is CREATE TABLE IF NOT EXISTS throughout, so
 * calling this repeatedly is safe. On a fresh deployment there is no ingest
 * token yet, which is why the token is only required when one is configured.
 */
export async function POST(req: Request) {
  if (!(await isIngestAuthorized(req))) return json({ error: "unauthorized" }, 401);
  try {
    const d = await db();

    // D1's exec() cannot cope with the leading comment block, so statements are
    // stripped of line comments and executed as a batch of prepared statements.
    const statements = SCHEMA_SQL.split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

    if (statements.length === 0) return json({ error: "schema file is empty" }, 500);

    for (let i = 0; i < statements.length; i += 40) {
      await d.batch(statements.slice(i, i + 40).map((sql) => d.prepare(sql)));
    }

    const e = await env();
    const existing = await d.prepare("SELECT COUNT(*) AS n FROM settings").first<{ n: number }>();
    if ((existing?.n ?? 0) === 0) {
      const statements = Object.entries(DEFAULT_SETTINGS).map(([k, v]) =>
        d.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind(k, String(v)),
      );
      await d.batch(statements);
    }

    const tables = await d
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();

    return json({
      ok: true,
      tables: (tables.results ?? []).map((t) => t.name),
      bindings: { db: Boolean(e.DB), files: Boolean(e.FILES) },
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
