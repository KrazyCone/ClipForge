import { db, env, getSettings } from "@/lib/db";
import { getUsersByLogin, streamsForUsers, twitchConfigured } from "@/lib/twitch";
import { bad, badRequestForLogin, json, readJson } from "@/lib/api";
import type { Channel } from "@/lib/types";
import { denied } from "@/lib/guard";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await denied();
  if (gate) return gate;
  try {
    const d = await db();
    const { results } = await d
      .prepare("SELECT * FROM channels ORDER BY monitor DESC, is_live DESC, login ASC")
      .all<Channel>();
    return json({ channels: results ?? [] });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

export async function POST(req: Request) {
  const gate = await denied();
  if (gate) return gate;
  const body = await readJson<{ login?: string }>(req);
  const invalid = badRequestForLogin(body?.login);
  if (invalid) return bad(invalid);

  const login = body!.login!.toLowerCase().trim();
  const e = await env();
  if (!twitchConfigured(e)) {
    return bad("Twitch is not configured. Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET as secrets.", 503);
  }

  try {
    const d = await db();
    const settings = await getSettings();

    const existing = await d
      .prepare("SELECT * FROM channels WHERE login = ?")
      .bind(login)
      .first<Channel>();
    if (existing) {
      await d.prepare("UPDATE channels SET monitor = 1 WHERE id = ?").bind(existing.id).run();
      return json({ channel: { ...existing, monitor: 1 }, created: false });
    }

    const monitored = await d
      .prepare("SELECT COUNT(*) AS n FROM channels WHERE monitor = 1")
      .first<{ n: number }>();
    if ((monitored?.n ?? 0) >= settings.maxChannels) {
      return bad(
        `Monitoring limit reached (${settings.maxChannels}). Raise "Maximum simultaneous channels" in Settings first. ` +
          `Each monitored channel costs roughly 1,440 D1 row writes per day.`,
        429,
      );
    }

    const users = await getUsersByLogin(e, [login], d);
    const user = users[0];
    if (!user) return bad(`Twitch user "${login}" not found`, 404);

    const now = new Date().toISOString();
    const live = await streamsForUsers(e, [user.id], d);
    const stream = live[0];

    await d
      .prepare(
        `INSERT INTO channels
          (id, login, display_name, avatar_url, description, monitor, source, is_live,
           title, game_name, game_id, viewer_count, started_at, last_live_at, last_polled_at,
           capture_mode, moments, created_at)
         VALUES (?, ?, ?, ?, ?, 1, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, 'vod', 0, ?)`,
      )
      .bind(
        user.id,
        user.login,
        user.display_name,
        user.profile_image_url ?? null,
        user.description ?? null,
        stream ? 1 : 0,
        stream?.title ?? null,
        stream?.game_name ?? null,
        stream?.game_id ?? null,
        stream?.viewer_count ?? null,
        stream?.started_at ?? null,
        stream ? now : null,
        now,
        now,
      )
      .run();

    const created = await d.prepare("SELECT * FROM channels WHERE id = ?").bind(user.id).first<Channel>();
    return json({ channel: created, created: true }, 201);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
