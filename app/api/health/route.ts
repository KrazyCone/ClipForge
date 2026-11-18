import { env } from "@/lib/db";
import { aiConfigured, DEFAULT_AI_MODEL } from "@/lib/ai";
import { twitchConfigured } from "@/lib/twitch";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const e = await env();
  let dbOk = false;
  let dbError: string | null = null;
  let counts: { channels: number; clips: number; spikes: number } | null = null;

  try {
    const row = await e.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM channels) AS channels, (SELECT COUNT(*) FROM clips) AS clips, (SELECT COUNT(*) FROM spikes) AS spikes",
    ).first<{ channels: number; clips: number; spikes: number }>();
    dbOk = true;
    counts = row ?? null;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  let r2Ok = false;
  try {
    await e.FILES.head("__healthcheck__");
    r2Ok = true;
  } catch {
    r2Ok = false;
  }

  const warnings: string[] = [];
  if (!twitchConfigured(e)) warnings.push("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set");
  if (!e.INGEST_TOKEN) warnings.push("INGEST_TOKEN not set - machine endpoints are unauthenticated");
  if (!aiConfigured(e)) warnings.push("No AI credentials - clips use the heuristic scorer");

  return json({
    ok: dbOk && r2Ok,
    bindings: { db: dbOk, r2: r2Ok },
    dbError,
    counts,
    config: {
      twitch: twitchConfigured(e),
      ai: aiConfigured(e),
      aiModel: e.AI_MODEL ?? DEFAULT_AI_MODEL,
      ingestToken: Boolean(e.INGEST_TOKEN),
      appOrigin: e.APP_ORIGIN ?? null,
    },
    warnings,
    time: new Date().toISOString(),
  });
}
