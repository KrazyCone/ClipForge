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

  /**
   * Signed HLS playlist for the *live* stream. This is the same public playback
   * path the Twitch web player uses - no DRM or access control is bypassed.
   * Only use it for channels you own or have permission to record.
   */
  async livePlaylist(login: string): Promise<string> {
    const res = await fetch(GQL, {
      method: "POST",
      headers: { "Client-Id": WEB_CLIENT_ID, "content-type": "application/json" },
      body: JSON.stringify({
        operationName: "PlaybackAccessToken",
        variables: {
          isLive: true,
          login: login.toLowerCase(),
          isVod: false,
          vodID: "",
          playerType: "site",
        },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: "0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712",
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`gql live ${res.status}`);
    const json = (await res.json()) as {
      data?: { streamPlaybackAccessToken?: { value: string; signature: string } };
    };
    const token = json.data?.streamPlaybackAccessToken;
    if (!token) throw new Error("no live playback token - is the channel live?");

    const master =
      `https://usher.ttvnw.net/api/channel/hls/${login.toLowerCase()}.m3u8` +
      `?allow_source=true&allow_audio_only=true&supported_codecs=h264` +
      `&nauth=${encodeURIComponent(token.value)}&nauthsig=${token.signature}` +
      `&player=twitchweb&p=${Math.floor(Math.random() * 9e6)}`;

    const mres = await fetch(master);
    if (!mres.ok) throw new Error(`live usher ${mres.status}`);
    return this.pickVariant(await mres.text());
  }

  /** Signed HLS playlist for a VOD, choosing the best variant up to 1080p. */
  async playlistFor(vodId: string): Promise<string> {
    const res = await fetch(GQL, {
      method: "POST",
      headers: { "Client-Id": WEB_CLIENT_ID, "content-type": "application/json" },
      body: JSON.stringify({
        operationName: "PlaybackAccessToken",
        variables: { isLive: false, login: "", isVod: true, vodID: vodId, playerType: "site" },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: "0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712",
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`gql ${res.status}`);
    const json = (await res.json()) as {
      data?: { videoPlaybackAccessToken?: { value: string; signature: string } };
    };
    const token = json.data?.videoPlaybackAccessToken;
    if (!token) throw new Error("no playback token - the VOD may be restricted or deleted");

    const master = `https://usher.ttvnw.net/vod/${vodId}.m3u8?allow_source=true&allow_audio_only=true` +
      `&nauth=${encodeURIComponent(token.value)}&nauthsig=${token.signature}` +
      `&player=twitchweb&supported_codecs=h264&p=${Math.floor(Math.random() * 9e6)}`;

    const mres = await fetch(master);
    if (!mres.ok) throw new Error(`usher ${mres.status}`);
    return this.pickVariant(await mres.text());
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

export function parseDuration(d: string): number {
  const m = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(d ?? "");
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
