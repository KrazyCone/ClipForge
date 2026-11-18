/**
 * Twitch VOD resolution.
 *
 * Clips are cut from the broadcaster's own archive VOD - the same recording the
 * public VOD player streams. There is no DRM or access-control bypass: if the
 * broadcaster has on-demand videos disabled, or the VOD has expired, capture is
 * unavailable and the moment is marked chat-only.
 */
import { log } from "./config.js";

const HELIX = "https://api.twitch.tv/helix";
const GQL = "https://gql.twitch.tv/gql";
// Public web client id, used for the playback access token the VOD page itself requests.
const WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
// usher/CDN reject requests that do not look like a browser player.
const PLAYER_HEADERS = {
  "Client-Id": WEB_CLIENT_ID,
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Origin: "https://www.twitch.tv",
  Referer: "https://www.twitch.tv/",
} as const;

/**
 * usher's playback authorisation moved from `nauth`/`nauthsig` to `token`/`sig`.
 * The retired pair is rejected with an empty 403 from CloudFront, which is why
 * a valid token could still fail to open a stream.
 */
function usherQuery(token: { value: string; signature: string }): string {
  return (
    `allow_source=true&allow_audio_only=true&supported_codecs=avc1` +
    `&token=${encodeURIComponent(token.value)}&sig=${encodeURIComponent(token.signature)}` +
    `&platform=web&player_backend=mediaplayer&playlist_include_framerate=true` +
    `&reassignments_supported=true&p=${Math.floor(Math.random() * 9e6)}`
  );
}

interface AccessToken {
  value: string;
  signature: string;
}

export interface TwitchVideo {
  id: string;
  user_id: string;
  created_at: string;
  duration: string;
  title: string;
  type: string;
}

export class TwitchVod {
  private token: string | null = null;
  private tokenExpiry = 0;

  constructor(
    private clientId: string | undefined = process.env.TWITCH_CLIENT_ID,
    private clientSecret: string | undefined = process.env.TWITCH_CLIENT_SECRET,
    private baseUrl: string | undefined = process.env.CLIPFORGE_BASE_URL?.replace(/\/+$/, ""),
    private ingestToken: string | undefined = process.env.INGEST_TOKEN,
  ) {}

  /**
   * Either the worker has its own Twitch app credentials, or it borrows the
   * site's through an INGEST_TOKEN-authenticated endpoint. The second form means
   * the client secret never has to be copied into GitHub Actions.
   */
  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret) || Boolean(this.baseUrl && this.ingestToken);
  }

  private async appToken(): Promise<string> {
    if (this.token && this.tokenExpiry > Date.now() / 1000 + 60) return this.token;
    if (!this.configured) throw new Error("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are not set");

    const res = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId!,
        client_secret: this.clientSecret!,
        grant_type: "client_credentials",
      }),
    });
    if (!res.ok) throw new Error(`twitch token ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = json.access_token;
    this.tokenExpiry = Date.now() / 1000 + json.expires_in;
    return this.token;
  }

  /** Archive VODs listed by the site, which already holds the credentials. */
  private async siteVideos(userId: string, first: number): Promise<TwitchVideo[]> {
    if (!this.baseUrl || !this.ingestToken) {
      throw new Error(
        "no Twitch access: set TWITCH_CLIENT_ID/SECRET, or CLIPFORGE_BASE_URL + INGEST_TOKEN to use the site's",
      );
    }
    const url = `${this.baseUrl}/api/twitch/videos?user_id=${encodeURIComponent(userId)}&first=${first}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.ingestToken}` } });
    if (!res.ok) throw new Error(`site videos ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const json = (await res.json()) as { videos?: TwitchVideo[] };
    return json.videos ?? [];
  }

  async archiveVideos(userId: string, first = 20): Promise<TwitchVideo[]> {
    if (!(this.clientId && this.clientSecret)) return this.siteVideos(userId, first);
    const token = await this.appToken();
    const url = new URL(`${HELIX}/videos`);
    url.searchParams.set("user_id", userId);
    url.searchParams.set("type", "archive");
    url.searchParams.set("first", String(first));
    const res = await fetch(url, {
      headers: { "Client-Id": this.clientId!, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`helix videos ${res.status}`);
    const json = (await res.json()) as { data: TwitchVideo[] };
    return json.data ?? [];
  }

  async findVodFor(userId: string, tsUnix: number): Promise<{ video: TwitchVideo; offset: number } | null> {
    const videos = await this.archiveVideos(userId);
    for (const v of videos) {
      const start = Math.floor(new Date(v.created_at).getTime() / 1000);
      const length = parseDuration(v.duration);
      if (length <= 0) continue;
      if (tsUnix >= start && tsUnix <= start + length) {
        return { video: v, offset: tsUnix - start };
      }
    }
    return null;
  }

  /** Playback access token for the public web player. */
  private async playbackToken(variables: Record<string, unknown>): Promise<AccessToken> {
    const res = await fetch(GQL, {
      method: "POST",
      headers: { "Client-Id": WEB_CLIENT_ID, "content-type": "application/json" },
      body: JSON.stringify({
        operationName: "PlaybackAccessToken",
        variables,
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: "0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712",
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`gql playback token ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const json = (await res.json()) as {
      data?: {
        streamPlaybackAccessToken?: AccessToken | null;
        videoPlaybackAccessToken?: AccessToken | null;
      };
    };
    const token = json.data?.streamPlaybackAccessToken ?? json.data?.videoPlaybackAccessToken;
    if (!token) throw new Error("no playback token - the channel may be offline or the VOD restricted");
    return token;
  }

  /**
   * Fetch a usher master playlist, trying several endpoint shapes.
   *
   * Twitch has served both `/api/channel/hls` and `/api/v2/channel/hls` over the
   * last year, and its edge answers a request it dislikes with a bare 403 whose
   * body is the only clue. Every failed attempt is logged with the status, the
   * edge node and the body so a blocked runner IP can be told apart from a bad
   * token without guessing.
   */
  private async fetchMaster(kind: string, paths: string[], token: AccessToken): Promise<string> {
    let last = "no attempt made";
    for (const path of paths) {
      const res = await fetch(`${path}?${usherQuery(token)}`, { headers: PLAYER_HEADERS });
      if (res.ok) return res.text();
      const body = (await res.text().catch(() => ""))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140);
      const edge = res.headers.get("server") ?? "";
      last = `${res.status}${edge ? ` via ${edge}` : ""}${body ? `: ${body}` : " (empty body)"}`;
      log(`usher ${new URL(path).pathname} (${kind}) -> ${last}`);
    }
    throw new Error(`${kind} usher ${last}`);
  }

  /**
   * Signed HLS playlist for the *live* stream. This is the same public playback
   * path the Twitch web player uses - no DRM or access control is bypassed.
   * Only use it for channels you own or have permission to record.
   */
  async livePlaylist(login: string): Promise<string> {
    const channel = login.toLowerCase();
    const paths = [
      `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8`,
      `https://usher.ttvnw.net/api/v2/channel/hls/${channel}.m3u8`,
    ];

    let text: string;
    try {
      text = await this.fetchMaster(
        "live",
        paths,
        await this.playbackToken({ isLive: true, login: channel, isVod: false, vodID: "", playerType: "site" }),
      );
    } catch (err) {
      // An independently signed, embed-scoped token carries a different claim
      // set and is accepted by edges that reject the site token.
      log(`live playlist retry for ${channel} after: ${msg(err)}`);
      text = await this.fetchMaster(
        "live/embed",
        paths,
        await this.playbackToken({ isLive: true, login: channel, isVod: false, vodID: "", playerType: "embed" }),
      );
    }
    return this.pickVariant(text);
  }

  /** Signed HLS playlist for a VOD, choosing the best variant up to 1080p. */
  async playlistFor(vodId: string): Promise<string> {
    const paths = [
      `https://usher.ttvnw.net/vod/${vodId}.m3u8`,
      `https://usher.ttvnw.net/vod/v2/${vodId}.m3u8`,
    ];
    const text = await this.fetchMaster(
      "vod",
      paths,
      await this.playbackToken({ isLive: false, login: "", isVod: true, vodID: vodId, playerType: "site" }),
    );
    return this.pickVariant(text);
  }

  /** Master playlist: pick the highest variant <= 1080p. */
  private pickVariant(text: string): string {
    const lines = text.split("\n");
    let bestUrl: string | null = null;
    let bestHeight = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
      const height = Number(/RESOLUTION=\d+x(\d+)/.exec(line)?.[1] ?? 0);
      const next = lines[i + 1]?.trim();
      if (!next || !next.startsWith("http")) continue;
      if (height <= 1080 && height > bestHeight) {
        bestHeight = height;
        bestUrl = next;
      }
    }
    if (!bestUrl) throw new Error("no usable HLS variant in playlist");
    log(`selected ${bestHeight}p HLS variant`);
    return bestUrl;
  }
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function parseDuration(d: string): number {
  const m = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(d ?? "");
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
