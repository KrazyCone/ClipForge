import type { Env } from "./db";

const HELIX = "https://api.twitch.tv/helix";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";

let cached: { token: string; expiresAt: number } | null = null;

export function twitchConfigured(e: Env): boolean {
  return Boolean(e.TWITCH_CLIENT_ID && e.TWITCH_CLIENT_SECRET);
}

export interface TwitchStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_id: string;
  game_name: string;
  type: string;
  title: string;
  viewer_count: number;
  started_at: string;
  language: string;
  thumbnail_url: string;
  tags?: string[];
}

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  description: string;
  profile_image_url: string;
  created_at: string;
}

export interface TwitchVideo {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  title: string;
  description: string;
  created_at: string;
  published_at: string;
  url: string;
  thumbnail_url: string;
  duration: string;
  type: string;
}

/**
 * App access token via the client credentials grant. Cached in module scope and
 * mirrored into D1 so separate Worker isolates reuse one token.
 */
export async function appToken(e: Env, d1?: D1Database): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt > now + 60) return cached.token;

  if (d1) {
    try {
      const row = await d1
        .prepare("SELECT value FROM settings WHERE key = 'twitch_token'")
        .first<{ value: string }>();
      if (row?.value) {
        const parsed = JSON.parse(row.value) as { token: string; expiresAt: number };
        if (parsed.expiresAt > now + 120) {
          cached = parsed;
          return cached.token;
        }
      }
    } catch {
      /* ignore cache read failures */
    }
  }

  if (!twitchConfigured(e)) {
    throw new Error("Twitch is not configured: set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.");
  }

  const body = new URLSearchParams({
    client_id: e.TWITCH_CLIENT_ID!,
    client_secret: e.TWITCH_CLIENT_SECRET!,
    grant_type: "client_credentials",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twitch token request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expiresAt: now + json.expires_in };

  if (d1) {
    try {
      await d1
        .prepare("INSERT INTO settings (key, value) VALUES ('twitch_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(JSON.stringify(cached))
        .run();
    } catch {
      /* cache write is best-effort */
    }
  }
  return cached.token;
}

async function helix<T>(
  e: Env,
  path: string,
  params: Record<string, string | string[] | number | undefined>,
  d1?: D1Database,
  attempt = 0,
): Promise<T[]> {
  const token = await appToken(e, d1);
  const url = new URL(`${HELIX}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
    else url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: {
      "Client-Id": e.TWITCH_CLIENT_ID!,
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 401 && attempt === 0) {
    cached = null;
    if (d1) {
      await d1.prepare("DELETE FROM settings WHERE key = 'twitch_token'").run().catch(() => {});
    }
    return helix<T>(e, path, params, d1, attempt + 1);
  }

  if (res.status === 429 && attempt < 2) {
    const reset = Number(res.headers.get("ratelimit-reset") ?? "1");
    const waitMs = Math.min(3000, Math.max(250, reset * 1000));
    await new Promise((r) => setTimeout(r, waitMs));
    return helix<T>(e, path, params, d1, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twitch ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as { data: T[] };
  return json.data ?? [];
}

/** Top live streams, ordered by viewers. This is Twitch's own discovery surface. */
export async function discoverLiveStreams(
  e: Env,
  opts: { first?: number; gameId?: string; language?: string } = {},
  d1?: D1Database,
): Promise<TwitchStream[]> {
  return helix<TwitchStream>(
    e,
    "/streams",
    {
      first: Math.min(opts.first ?? 40, 100),
      game_id: opts.gameId,
      language: opts.language,
    },
    d1,
  );
}

export async function streamsForUsers(
  e: Env,
  userIds: string[],
  d1?: D1Database,
): Promise<TwitchStream[]> {
  if (userIds.length === 0) return [];
  const out: TwitchStream[] = [];
  for (let i = 0; i < userIds.length; i += 100) {
    out.push(
      ...(await helix<TwitchStream>(e, "/streams", { user_id: userIds.slice(i, i + 100) }, d1)),
    );
  }
  return out;
}

export async function getUsersByLogin(
  e: Env,
  logins: string[],
  d1?: D1Database,
): Promise<TwitchUser[]> {
  if (logins.length === 0) return [];
  return helix<TwitchUser>(e, "/users", { login: logins.map((l) => l.toLowerCase()) }, d1);
}

export async function getUsersById(
  e: Env,
  ids: string[],
  d1?: D1Database,
): Promise<TwitchUser[]> {
  if (ids.length === 0) return [];
  return helix<TwitchUser>(e, "/users", { id: ids }, d1);
}

/** Archive VODs (past broadcasts), newest first. Used for compliant clip capture. */
export async function getArchiveVideos(
  e: Env,
  userId: string,
  first = 20,
  d1?: D1Database,
): Promise<TwitchVideo[]> {
  return helix<TwitchVideo>(
    e,
    "/videos",
    { user_id: userId, type: "archive", first },
    d1,
  );
}

/** "1h2m3s" -> 3723 */
export function parseTwitchDuration(d: string): number {
  const m = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(d ?? "");
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * Find the archive VOD covering a given unix timestamp. Twitch only exposes VODs
 * when the broadcaster has on-demand videos enabled, so a null result means
 * "chat-only monitoring" for that moment - not an error.
 */
export function findVodForTimestamp(
  videos: TwitchVideo[],
  tsUnix: number,
): { video: TwitchVideo; offsetSec: number } | null {
  for (const v of videos) {
    const start = Math.floor(new Date(v.created_at).getTime() / 1000);
    const len = parseTwitchDuration(v.duration);
    if (len <= 0) continue;
    const end = start + len;
    if (tsUnix >= start && tsUnix <= end) {
      return { video: v, offsetSec: tsUnix - start };
    }
  }
  return null;
}
