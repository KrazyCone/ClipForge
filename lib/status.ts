import { env } from "./db";
import { aiConfigured, DEFAULT_AI_MODEL } from "./ai";
import { twitchConfigured } from "./twitch";

export interface SystemStatus {
  twitch: boolean;
  ai: boolean;
  aiModel: string;
  ingestToken: boolean;
  d1: boolean;
  r2: boolean;
  appOrigin: string | null;
}

export async function getSystemStatus(): Promise<SystemStatus> {
  try {
    const e = await env();
    return {
      twitch: twitchConfigured(e),
      ai: aiConfigured(e),
      aiModel: e.AI_MODEL ?? DEFAULT_AI_MODEL,
      ingestToken: Boolean(e.INGEST_TOKEN),
      d1: Boolean(e.DB),
      r2: Boolean(e.FILES),
      appOrigin: e.APP_ORIGIN ?? null,
    };
  } catch {
    return {
      twitch: false,
      ai: false,
      aiModel: "heuristic",
      ingestToken: false,
      d1: false,
      r2: false,
      appOrigin: null,
    };
  }
}
