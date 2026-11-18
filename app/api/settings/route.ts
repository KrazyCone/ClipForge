import { getSettings, saveSettings } from "@/lib/db";
import { json, readJson } from "@/lib/api";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { denied } from "@/lib/guard";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await denied();
  if (gate) return gate;
  return json({ settings: await getSettings(), defaults: DEFAULT_SETTINGS });
}

export async function PUT(req: Request) {
  const gate = await denied();
  if (gate) return gate;
  const body = await readJson<Record<string, unknown>>(req);
  if (!body) return json({ error: "invalid JSON body" }, 400);

  // Validate ranges so a bad setting cannot break the pipeline.
  const bounds: Record<string, [number, number]> = {
    spikeSensitivity: [0, 100],
    maxChannels: [1, 50],
    clipDurationSec: [6, 60],
    preEventSec: [2, 30],
    postEventSec: [2, 30],
    minQualityScore: [0, 95],
    frameSampleFps: [0.1, 4],
    storageLimitMb: [50, 1000],
  };

  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    if (key in bounds) {
      const n = Number(value);
      if (!Number.isFinite(n)) return json({ error: `${key} must be a number` }, 400);
      const [lo, hi] = bounds[key];
      clean[key] = Math.min(hi, Math.max(lo, n));
    } else if (typeof DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS] === "boolean") {
      clean[key] = Boolean(value);
    } else if (key === "aspectRatio") {
      if (!["9:16", "1:1", "16:9"].includes(String(value))) {
        return json({ error: "aspectRatio must be 9:16, 1:1 or 16:9" }, 400);
      }
      clean[key] = String(value);
    } else if (key === "subtitleStyle") {
      if (!["bold", "clean", "karaoke"].includes(String(value))) {
        return json({ error: "subtitleStyle must be bold, clean or karaoke" }, 400);
      }
      clean[key] = String(value);
    } else if (key === "clipDirection") {
      clean[key] = String(value ?? "").slice(0, 1200);
    }
  }

  try {
    await saveSettings(clean);
    return json({ settings: await getSettings() });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
