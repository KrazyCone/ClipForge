/**
 * Twitch chat collector.
 *
 * Holds anonymous read-only IRC connections over Twitch's public WebSocket
 * endpoint, aggregates messages into per-minute rows, and runs the adaptive
 * spike detector locally. Only aggregates and spike summaries leave this
 * process - raw chat is never persisted.
 *
 * Twitch's IRC gateway is the documented public chat transport; anonymous
 * read-only connections are supported and no credentials are required. Supply
 * TWITCH_BOT_LOGIN / TWITCH_BOT_TOKEN to connect as a real account instead.
 */
import WebSocket from "ws";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, log } from "./config.js";
import { ClipforgeApi } from "./api.js";
import type { AgentSettings, MinutePayload, SpikePayload } from "./api.js";
import { configFromSensitivity, detectSpike } from "../../lib/spike.js";
import type { ChatMessage } from "../../lib/spike.js";
import { LiveRecorder, sleep } from "./live.js";
import { TwitchVod } from "./twitch.js";
import { analyseLocal, cleanupWorkDir, produceClipFromFile } from "./produce.js";

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";

interface ChannelState {
  id: string;
  login: string;
  displayName: string;
  messages: ChatMessage[];
  minuteStart: number;
  minuteCounts: number[]; // 12 buckets of 5s
  minuteUsers: Set<string>;
  minuteEmotes: number;
  minuteRepeats: number;
  minuteUpper: number;
  minuteLetters: number;
  minuteEmoteCounts: Map<string, number>;
  samples: string[];
  lastSpikeAt: number;
  seenFingerprints: Map<string, number>;
}

const anonNick = () => `justinfan${Math.floor(10000 + Math.random() * 80000)}`;

function parseTags(raw: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    tags[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return tags;
}

/** `25:0-4,12-16/1902:6-10` -> ["Kappa", "Keepo"] via the emote id map we keep per message. */
function parseEmotes(emotesTag: string | undefined): string[] {
  if (!emotesTag) return [];
  return emotesTag
    .split("/")
    .map((e) => e.split(":")[0])
    .filter(Boolean)
    .slice(0, 8);
}

function normaliseForRepeat(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\b(\w+)(\s+\1\b)+/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export class Collector {
  private states = new Map<string, ChannelState>();
  private ws: WebSocket | null = null;
  private settings: AgentSettings | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private detectTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private reconnectAttempts = 0;
  private joined = new Set<string>();
  private recorders = new Map<string, LiveRecorder>();
  private vod = new TwitchVod();
  private liveRenders = 0;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling = false;

  constructor(
    private api: ClipforgeApi,
    private cfg: ReturnType<typeof loadConfig>,
  ) {}

  async start(): Promise<void> {
    const queue = await this.api.queue(1);
    this.settings = queue.settings;

    const channels = queue.channels
      .filter((c) => c.capture_mode !== "none")
      .slice(0, Math.min(this.cfg.maxChannels, queue.settings.maxChannels));

    if (channels.length === 0) {
      log("no monitored channels - nothing to collect");
      await this.api.recordRun("collector", "idle", "no monitored channels");
      return;
    }

    for (const c of channels) this.addChannel(c);

    // Live status changes during a long run, so buffers and chat joins are
    // reconciled periodically rather than decided once at startup.
    this.startReconcileLoop();

    log(`collecting ${this.states.size} channel(s): ${[...this.states.keys()].join(", ")}`);
    await this.connect();

    this.flushTimer = setInterval(() => void this.flushCompletedMinutes(), 15000);
    this.detectTimer = setInterval(() => void this.detectAll(), 5000);

    await this.api.recordRun(
      "collector",
      "running",
      `joined ${[...this.states.keys()].join(",")}`,
    );

    // Self-terminate so the scheduled job can restart cleanly (Actions default).
    setTimeout(() => void this.stop("run window elapsed"), this.cfg.runSeconds * 1000);

    await new Promise<void>((resolve) => {
      this.onStop = resolve;
    });
  }

  private onStop: (() => void) | null = null;

  async stop(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    log(`stopping: ${reason}`);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.detectTimer) clearInterval(this.detectTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const recorder of this.recorders.values()) await recorder.stop();
    this.recorders.clear();
    await this.flushAll().catch((err) => log("final flush failed", String(err)));
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    await this.api.recordRun("collector", "stopped", reason);
    this.onStop?.();
  }

  private async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(IRC_URL);
      this.ws = ws;
      let settled = false;

      ws.on("open", () => {
        log("irc connected");
        this.reconnectAttempts = 0;
        ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
        if (this.cfg.twitchToken && this.cfg.twitchLogin) {
          ws.send(`PASS oauth:${this.cfg.twitchToken}`);
          ws.send(`NICK ${this.cfg.twitchLogin.toLowerCase()}`);
        } else {
          ws.send(`NICK ${anonNick()}`);
        }
        for (const login of this.states.keys()) {
          ws.send(`JOIN #${login}`);
          this.joined.add(login);
        }
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on("message", (data: WebSocket.RawData) => this.onIrc(data.toString()));

      ws.on("error", (err) => {
        log("irc error", err.message);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.on("close", () => {
        this.joined.clear();
        if (this.stopping) return;
        const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempts++);
        log(`irc closed, reconnecting in ${delay}ms`);
        setTimeout(() => {
          this.connect().catch((err) => log("reconnect failed", String(err)));
        }, delay);
      });
    });
  }

  private onIrc(payload: string): void {
    for (const line of payload.split("\r\n")) {
      if (!line) continue;

      if (line.startsWith("PING")) {
        this.ws?.send("PONG :tmi.twitch.tv");
        continue;
      }

      // Tags are only present because we requested twitch.tv/tags.
      let tags: Record<string, string> = {};
      let rest = line;
      if (line.startsWith("@")) {
        const space = line.indexOf(" ");
        tags = parseTags(line.slice(1, space));
        rest = line.slice(space + 1);
      }

      const privmsg = rest.indexOf(" PRIVMSG #");
      if (privmsg < 0) continue;

      const afterChannel = rest.slice(privmsg + " PRIVMSG #".length);
      const colon = afterChannel.indexOf(" :");
      if (colon < 0) continue;
      const channel = afterChannel.slice(0, colon).toLowerCase();
      const text = afterChannel.slice(colon + 2);

      const state = this.states.get(channel);
      if (!state) continue;

      const user = tags["display-name"] || tags.login || rest.slice(1, rest.indexOf("!"));
      const emotes = parseEmotes(tags.emotes);
      const nowSec = Date.now() / 1000;

      state.messages.push({ t: nowSec, text, user, emotes });
      // 90s of raw messages is enough for the detector's longest window.
      if (state.messages.length > 4000) state.messages.splice(0, state.messages.length - 4000);
      const cutoff = nowSec - 120;
      while (state.messages.length && state.messages[0].t < cutoff) state.messages.shift();

      this.accumulate(state, text, user, emotes, nowSec);
    }
  }

  private accumulate(
    state: ChannelState,
    text: string,
    user: string,
    emotes: string[],
    nowSec: number,
  ): void {
    const minute = Math.floor(nowSec / 60) * 60;
    if (minute !== state.minuteStart) {
      // Roll over; the previous minute is flushed by the timer shortly.
      void this.flushMinute(state, state.minuteStart);
      state.minuteStart = minute;
      state.minuteCounts = new Array(12).fill(0);
      state.minuteUsers = new Set();
      state.minuteEmotes = 0;
      state.minuteRepeats = 0;
      state.minuteUpper = 0;
      state.minuteLetters = 0;
      state.minuteEmoteCounts = new Map();
      state.samples = [];
    }

    const bucket = Math.min(11, Math.floor((nowSec - minute) / 5));
    state.minuteCounts[bucket] += 1;
    state.minuteUsers.add(user);

    if (emotes.length) {
      state.minuteEmotes += 1;
      for (const e of emotes) {
        state.minuteEmoteCounts.set(e, (state.minuteEmoteCounts.get(e) ?? 0) + 1);
      }
    }

    const fingerprint = normaliseForRepeat(text);
    if (fingerprint) {
      const last = state.seenFingerprints.get(fingerprint);
      if (last && nowSec - last < 60) state.minuteRepeats += 1;
      state.seenFingerprints.set(fingerprint, nowSec);
      if (state.seenFingerprints.size > 500) {
        // prune old fingerprints
        for (const [key, ts] of state.seenFingerprints) {
          if (nowSec - ts > 120) state.seenFingerprints.delete(key);
        }
      }
    }

    const letters = text.replace(/[^a-zA-Z]/g, "");
    state.minuteLetters += letters.length;
    state.minuteUpper += letters.replace(/[^A-Z]/g, "").length;

    state.samples.push(`${user}: ${text.slice(0, 140)}`);
    if (state.samples.length > 20) state.samples.shift();
  }

  private async flushMinute(state: ChannelState, minuteStart: number): Promise<void> {
    if (state.minuteCounts.every((n) => n === 0)) return;

    const topEmotes = [...state.minuteEmoteCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([id, count]) => `${id}:${count}`);

    const payload: MinutePayload = {
      tsMinute: minuteStart,
      msgCount: state.minuteCounts.reduce((a, b) => a + b, 0),
      uniqueChatters: state.minuteUsers.size,
      emoteCount: state.minuteEmotes,
      repeatCount: state.minuteRepeats,
      capsRatio: state.minuteLetters ? state.minuteUpper / state.minuteLetters : 0,
      emotes: topEmotes,
      buckets: state.minuteCounts,
      samples: state.samples.slice(-12),
    };

    try {
      await this.api.ingest({ login: state.login, minute: payload });
    } catch (err) {
      log(`ingest minute failed for ${state.login}`, String(err));
    }
  }

  /** Flush every completed minute for every channel. */
  private async flushCompletedMinutes(): Promise<void> {
    const nowMinute = Math.floor(Date.now() / 1000 / 60) * 60;
    for (const state of this.states.values()) {
      if (state.minuteStart < nowMinute) {
        await this.flushMinute(state, state.minuteStart);
        // Reset the completed minute's counters without waiting for a message.
        state.minuteStart = nowMinute;
        state.minuteCounts = new Array(12).fill(0);
        state.minuteUsers = new Set();
        state.minuteEmotes = 0;
        state.minuteRepeats = 0;
        state.minuteUpper = 0;
        state.minuteLetters = 0;
        state.minuteEmoteCounts = new Map();
      }
    }
  }

  private async flushAll(): Promise<void> {
    for (const state of this.states.values()) await this.flushMinute(state, state.minuteStart);
  }

  /** Adds a chat state (and joins the IRC channel) for a monitored channel. */
  private addChannel(channel: { id: string; login: string; display_name: string }): void {
    const login = channel.login.toLowerCase();
    if (this.states.has(login)) return;
    this.states.set(login, {
      id: channel.id,
      login,
      displayName: channel.display_name,
      messages: [],
      minuteStart: Math.floor(Date.now() / 1000 / 60) * 60,
      minuteCounts: new Array(12).fill(0),
      minuteUsers: new Set(),
      minuteEmotes: 0,
      minuteRepeats: 0,
      minuteUpper: 0,
      minuteLetters: 0,
      minuteEmoteCounts: new Map(),
      samples: [],
      lastSpikeAt: 0,
      seenFingerprints: new Map(),
    });
    if (this.ws?.readyState === WebSocket.OPEN && !this.joined.has(login)) {
      this.ws.send(`JOIN #${login}`);
      this.joined.add(login);
      log(`joined #${login} mid-run`);
    }
  }

  private startReconcileLoop(): void {
    if (!this.vod.configured) {
      log("TWITCH_CLIENT_ID/SECRET missing - live capture disabled, VOD path only");
    }
    void this.reconcileBuffers();
    // Five minutes: each refresh writes one row per channel, so the cadence is
    // part of the D1 write budget (288 rows/day/channel at this interval).
    this.reconcileTimer = setInterval(() => void this.reconcileBuffers(), 300_000);
  }

  private bufferSeconds(): number {
    const settings = this.settings;
    return Math.max(
      120,
      (settings?.preEventSec ?? 8) + (settings?.postEventSec ?? 10) + 120,
    );
  }

  /**
   * Polls the app for current live status, then starts/stops ring buffers and
   * chat memberships to match. A stream that goes live three hours into a run
   * is picked up within a few minutes instead of waiting for the next run.
   */
  private async reconcileBuffers(): Promise<void> {
    if (this.reconciling || this.stopping) return;
    this.reconciling = true;
    try {
      const live = await this.api.refreshLive();
      const monitored = new Map(
        live.channels.map((c) => [c.login.toLowerCase(), c] as const),
      );

      for (const channel of live.channels) {
        this.addChannel(channel);
      }

      // Stop buffering channels that went offline or were removed.
      for (const [login, recorder] of [...this.recorders]) {
        const channel = monitored.get(login);
        if (!channel || channel.is_live !== 1) {
          await recorder.stop();
          this.recorders.delete(login);
          log(`live buffer stopped for ${login}`);
        }
      }

      if (!this.vod.configured) return;

      for (const channel of live.channels) {
        const login = channel.login.toLowerCase();
        if (channel.is_live !== 1 || channel.capture_mode === "chat_only") continue;
        if (this.recorders.has(login)) continue;
        try {
          const playlist = await this.vod.livePlaylist(channel.login);
          const recorder = new LiveRecorder(
            channel.login,
            playlist,
            this.bufferSeconds(),
            () => this.vod.livePlaylist(channel.login),
          );
          await recorder.start();
          this.recorders.set(login, recorder);
        } catch (err) {
          log(
            `live buffer unavailable for ${channel.login}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      log(`live reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Turns a just-detected spike into a finished clip from the ring buffer, in
   * the same process, with no VOD dependency.
   */
  private async captureLive(state: ChannelState, ts: number, spikeId: string): Promise<void> {
    const recorder = this.recorders.get(state.login);
    const settings = this.settings;
    if (!recorder || !settings) return;
    if (this.liveRenders >= 2) {
      log("live render concurrency limit reached - spike left for the VOD renderer");
      return;
    }
    this.liveRenders++;

    let workDir: string | null = null;
    try {
      // Wait for the post-roll to be written into the buffer.
      await sleep((settings.postEventSec + 2) * 1000);

      const snap = await recorder.snapshot(ts, settings.preEventSec, settings.postEventSec);
      if (!snap) {
        log(`no buffer coverage for ${state.login} - falling back to VOD`);
        return;
      }

      const startInSnap = Math.max(0, ts - settings.preEventSec - snap.startSec);
      const window = Math.min(45, settings.preEventSec + settings.postEventSec + 12);

      workDir = await mkdtemp(path.join(tmpdir(), "clipforge-live-"));
      const analysis = await analyseLocal(
        this.api,
        spikeId,
        snap.file,
        startInSnap,
        window,
        settings.frameSampleFps,
        workDir,
      );

      if (!analysis?.clipId || !analysis.clip) {
        log(`live analysis produced no clip for ${state.login}`);
        return;
      }

      await produceClipFromFile({
        api: this.api,
        clip: analysis.clip,
        sourceFile: snap.file,
        sourceStartSec: snap.startSec,
        settings,
        workDir,
        transcript: analysis.transcript,
      });
    } catch (err) {
      log(`live capture failed for ${state.login}: ${err instanceof Error ? err.message : String(err)}`);
      // Hand the moment back so the scheduled renderer can try the VOD path.
      await this.api.setSpikeStatus(spikeId, "queued").catch(() => {});
    } finally {
      this.liveRenders--;
      if (workDir) await cleanupWorkDir(workDir);
    }
  }

  /** Runs the detector on every channel and posts qualifying events. */
  private async detectAll(): Promise<void> {
    if (!this.settings) return;
    const cfg = configFromSensitivity(this.settings.spikeSensitivity);
    const now = Date.now() / 1000;

    for (const state of this.states.values()) {
      if (now - state.lastSpikeAt < cfg.cooldownSeconds) continue;
      if (state.messages.length < cfg.minMessages) continue;

      const candidate = detectSpike(state.messages, now, cfg);
      if (!candidate) continue;

      state.lastSpikeAt = now;
      const payload: SpikePayload = {
        tsUnix: Math.round(candidate.ts),
        messageCount: candidate.features.messageCount,
        baselineRate: candidate.features.baselineRate,
        peakRate: candidate.features.peakRate,
        uniqueChatters: candidate.features.uniqueChatters,
        intensity: candidate.intensity,
        zScore: candidate.features.zScore,
        features: candidate.features as unknown as Record<string, unknown>,
        samples: candidate.samples,
      };

      try {
        const result = await this.api.ingest({ login: state.login, spike: payload });
        log(
          `spike ${state.login} intensity=${candidate.intensity} ` +
            `${candidate.features.baselineRate.toFixed(1)}/s -> ${candidate.features.peakRate}/s ` +
            `(${result.merged ? "merged" : "new"} ${result.spikeId ?? ""})`,
        );

        // Render straight from the local ring buffer so the clip exists while
        // the stream is still live. Falls back to the VOD renderer on failure.
        if (result.spikeId && !result.merged) {
          void this.captureLive(state, candidate.ts, result.spikeId);
        }
      } catch (err) {
        log(`spike ingest failed for ${state.login}`, String(err));
      }
    }
  }
}

async function main() {
  const cfg = loadConfig();
  const api = new ClipforgeApi(cfg);
  const collector = new Collector(api, cfg);

  const shutdown = (signal: string) => void collector.stop(signal);
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await collector.start();
  } catch (err) {
    log("collector failed", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
