/** Everything the worker needs comes from environment variables. */
export interface AgentConfig {
  baseUrl: string;
  ingestToken: string;
  twitchLogin: string | null;
  twitchToken: string | null;
  /** how long a collector run stays connected, seconds */
  runSeconds: number;
  /** max channels to join in one run */
  maxChannels: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in the worker environment (GitHub Actions secrets or a .env file).`,
    );
  }
  return value;
}

export function loadConfig(): AgentConfig {
  const baseUrl = required("CLIPFORGE_BASE_URL").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error("CLIPFORGE_BASE_URL must start with http:// or https://");
  }
  return {
    baseUrl,
    ingestToken: process.env.INGEST_TOKEN ?? "",
    twitchLogin: process.env.TWITCH_BOT_LOGIN || null,
    twitchToken: process.env.TWITCH_BOT_TOKEN || null,
    runSeconds: Number(process.env.RUN_SECONDS ?? 60 * 25),
    maxChannels: Number(process.env.MAX_CHANNELS ?? 5),
  };
}

export function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}
