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
import { appendFile, mkdtemp } from "node:fs/promises";
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
import { describeDrain, drainQueue } from "./render.js";

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
/** End the run once nothing has been live for this long, instead of idling for hours. */
const IDLE_EXIT_MS = 15 * 60_000;
/** Reconnect if a live channel's chat has been silent for this long: the socket is usually dead. */
const SILENT_SOCKET_MS = 10 * 60_000;
const HEARTBEAT_MS = 5 * 60_000;
/** Let a channel build a baseline before judging its chat. */
const DETECT_WARMUP_SEC = 60;
/** How long a run with nothing to watch waits before the next one starts. */
const IDLE_HANDOVER_SEC = 300;

interface ChannelState {
  id: string;
  login: string;
  /** unix seconds this channel was added; detection waits for a real baseline */
  joinedAt: number;
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
  /** channels Twitch has confirmed the JOIN for on the current socket */
  private joinConfirmed = new Set<string>();
  /** re-join attempts per channel, so a dead channel cannot loop forever */
  private joinRetries = new Map<string, number>();
  private recorders = new Map<string, LiveRecorder>();
  private vod = new TwitchVod();
  private liveRenders = 0;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling = false;
  private drainTimer: NodeJS.Timeout | null = null;
  private draining = false;
  /** Spikes that arrived while both live render slots were busy. */
  private pendingLive: { login: string; ts: number; spikeId: string }[] = [];
  /** Re-cuts already reported as waiting for the archive VOD, so it logs once. */
  private deferredRebuilds = new Set<string>();
  /** true while a detection pass is in flight, so slow networks cannot pile up runs */
  private detecting = false;
  /** unix seconds of the last moment detection actually emitted, for the heartbeat */
  private lastDetectionAt = 0;
  /** unix seconds of the last completed detection pass, so a stalled loop is visible */
  private lastDetectPassAt = 0;
  private watchTimer: NodeJS.Timeout | null = null;
  private windowTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = Date.now();
  private lastLiveAt = Date.now();
  private lastBeatAt = Date.now();
  private messagesSinceBeat = 0;
  private capLogged = false;

  constructor(
    private api: ClipforgeApi,
    private cfg: ReturnType<typeof loadConfig>,
  ) {}

  async start(): Promise<void> {
    const queue = await this.api.queue(1);
    this.settings = queue.settings;

    // MAX_CHANNELS is the hard cost limit. settings.maxChannels only guards the
    // "add channel" button; applying both here meant lowering that setting
    // silently stopped collecting channels that were already being watched, and
    // their charts just went flat with nothing explaining why.
    const monitored = queue.channels.filter((c) => c.capture_mode !== "none");
    const channels = monitored.slice(0, this.cfg.maxChannels);
    const overCap = monitored.slice(this.cfg.maxChannels).map((c) => c.login);
    if (overCap.length) {
      log(
        `MAX_CHANNELS=${this.cfg.maxChannels} - not collecting ${overCap.join(", ")} ` +
          `(raise it in the workflow to cover every channel)`,
      );
    }

    if (channels.length === 0) {
      log("no monitored channels - nothing to collect");
      await this.api.recordRun("collector", "idle", "no monitored channels");
      return;
    }

    for (const c of channels) this.addChannel(c);

    // Live status changes during a long run, so buffers and chat joins are
    // reconciled periodically rather than decided once at startup.
    this.startReconcileLoop();

    // Anything the live path could not cut (a burst that filled both render
    // slots, a moment outside the ring buffer) still has to become a clip, and
    // this job is the only one guaranteed to be running.
    this.startDrainLoop();

    log(`collecting ${this.states.size} channel(s): ${[...this.states.keys()].join(", ")}`);
    await this.connect();
    this.startWatchdog();

    this.flushTimer = setInterval(() => void this.flushCompletedMinutes(), 15000);
    this.detectTimer = setInterval(() => void this.detectAll(), 5000);

    await this.api.recordRun(
      "collector",
      "running",
      `joined ${[...this.states.keys()].join(",")}`,
    );

    // Self-terminate so the scheduled job can restart cleanly (Actions default).
    // Stored and unref'd: if the watchdog ends the run early, a leftover timer
    // must not keep the process (and the job) alive for the rest of the window.
    this.windowTimer = setTimeout(() => void this.stop("run window elapsed"), this.cfg.runSeconds * 1000);
    this.windowTimer.unref();

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
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.windowTimer) clearTimeout(this.windowTimer);
    for (const recorder of this.recorders.values()) await recorder.stop();
    this.recorders.clear();
    await this.flushAll().catch((err) => log("final flush failed", String(err)));
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    // The collected list is on the stop record because that is the newest row:
    // it is how the dashboard can show which channels the run covered.
    const collected = [...this.states.keys()].join(",");
    await this.api.recordRun(
      "collector",
      "stopped",
      collected ? `${reason} - collected ${collected}` : reason,
    );
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
        // A fresh socket starts with nothing confirmed: Twitch can accept the
        // connection and still drop a JOIN, which shows up later as one channel
        // with a perfectly flat chat line and no error anywhere.
        this.joinConfirmed.clear();
        this.joinRetries.clear();
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

      // `:name!name@name.tmi.twitch.tv JOIN #channel` is the only proof that
      // chat for that channel will actually arrive.
      const joinAt = line.indexOf(" JOIN #");
      if (joinAt > 0) {
        this.joinConfirmed.add(line.slice(joinAt + " JOIN #".length).trim().toLowerCase());
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

      this.lastMessageAt = Date.now();
      this.messagesSinceBeat++;

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
      joinedAt: Date.now() / 1000,
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

  /**
   * Keeps a long run honest: it reports that chat is still arriving, reconnects
   * an IRC socket that has gone silent, and ends the run when nothing is live
   * instead of sitting on a runner for the rest of the window.
   */
  private startWatchdog(): void {
    this.watchTimer = setInterval(() => void this.watchdogTick(), 60_000);
  }

  private async watchdogTick(): Promise<void> {
    if (this.stopping) return;
    const now = Date.now();

    if (now - this.lastLiveAt > IDLE_EXIT_MS) {
      const idleMin = Math.round((now - this.lastLiveAt) / 60_000);
      log(`no monitored channel has been live for ${idleMin} min - ending this run and handing over`);
      await this.handOver(IDLE_HANDOVER_SEC);
      await this.stop("no live channels");
      return;
    }

    const silentFor = now - this.lastMessageAt;
    if (silentFor > SILENT_SOCKET_MS) {
      // A live channel that sends nothing for ten minutes is almost always a
      // socket Twitch stopped delivering on rather than a quiet chat.
      log(`no chat for ${Math.round(silentFor / 1000)}s while a channel is live - reconnecting irc`);
      this.lastMessageAt = now;
      try {
        this.ws?.close();
      } catch {
        /* already closed */
      }
      return;
    }

    // A JOIN that was never confirmed is a silent hole: no messages means no
    // chart, no spike and no error. Re-ask a few times instead of leaving it.
    if (this.ws?.readyState === WebSocket.OPEN) {
      for (const login of this.states.keys()) {
        if (this.joinConfirmed.has(login)) continue;
        const retries = this.joinRetries.get(login) ?? 0;
        if (retries >= 3) continue;
        this.joinRetries.set(login, retries + 1);
        this.ws.send(`JOIN #${login}`);
        log(`irc join unconfirmed for #${login} - re-joining (attempt ${retries + 2})`);
      }
    }

    if (now - this.lastBeatAt >= HEARTBEAT_MS) {
      // The last-detection age makes a dead detector visible: heartbeats alone
      // stay healthy while no spike can be emitted at all.
      const lastSpike = this.lastDetectionAt
        ? `${Math.round((now - this.lastDetectionAt * 1000) / 60_000)} min ago`
        : "never this run";
      const lastPass = this.lastDetectPassAt
        ? `${Math.round((now - this.lastDetectPassAt * 1000) / 60_000)} min ago`
        : "never";
      const unconfirmed = [...this.states.keys()].filter((l) => !this.joinConfirmed.has(l));
      log(
        `heartbeat: ${this.states.size} channel(s) joined, ${this.recorders.size} buffering, ` +
          `${this.messagesSinceBeat} chat message(s) in the last ${Math.round((now - this.lastBeatAt) / 60_000)} min, ` +
          `last detector pass ${lastPass}, last spike ${lastSpike}` +
          (unconfirmed.length ? `, join unconfirmed for ${unconfirmed.join(",")}` : ""),
      );
      // Recorded, not just logged: the dashboard reads the newest run row, so a
      // heartbeat keeps "collector" honest while a long run is still going and
      // names the channels it is actually listening to.
      await this.api.recordRun(
        "collector",
        "running",
        `watching ${[...this.states.keys()].join(",")}` +
          (unconfirmed.length ? `; join unconfirmed: ${unconfirmed.join(",")}` : "") +
          `; ${this.messagesSinceBeat} msg in ${Math.round((now - this.lastBeatAt) / 60_000)} min`,
      );
      this.lastBeatAt = now;
      this.messagesSinceBeat = 0;
    }
  }

  /** Tells the workflow how long to wait before it queues the next run. */
  private async handOver(delaySeconds: number): Promise<void> {
    const file = process.env.GITHUB_ENV;
    if (!file) return;
    await appendFile(file, `NEXT_RUN_DELAY=${delaySeconds}\n`).catch(() => {});
  }

  private startDrainLoop(): void {
    if (!this.vod.configured) return;
    // Not immediately: the first bursts of a run are the live path's job, and
    // an archive VOD does not exist until a stream has ended anyway.
    const firstDrain = setTimeout(() => void this.drainQueuedWork(), 60_000);
    firstDrain.unref();
    // A re-cut should land in a couple of minutes, not after the next long
    // drain interval; the pass is cheap when there is no work.
    this.drainTimer = setInterval(() => void this.drainQueuedWork(), 60_000);
  }

  /**
   * Renders whatever is still queued from the archive VOD. Spikes younger than
   * two minutes are left alone so this never races the live capture path.
   */
  private async drainQueuedWork(): Promise<void> {
    if (this.draining || this.stopping || !this.vod.configured) return;
    this.draining = true;
    try {
      // Re-cuts first: a queued rebuild of a live moment can be served by the
      // ring buffer, whereas drainQueue would defer it until the stream ends.
      await this.drainLiveRebuilds();
      const result = await drainQueue({
        api: this.api,
        vod: this.vod,
        limit: 2,
        minSpikeAgeSec: 120,
      });
      // Deferrals are the normal state for a stream that has not ended, so only
      // report passes that actually produced or lost something.
      if (result.analyzed || result.rendered || result.errors.length) {
        log(`queue drain: ${describeDrain(result)}`);
      }
    } catch (err) {
      log(`queue drain failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.draining = false;
    }
  }

  private bufferSeconds(): number {
    const settings = this.settings;
    // A re-cut is the reason this is not just "a bit more than a clip": the
    // moment being re-cut is usually a clip made several minutes ago, and while
    // the stream is still live there is no archive VOD to fall back on. The
    // extra 900s (about fifteen minutes of recent footage) is what lets most
    // re-cuts be cut immediately instead of waiting for the stream to end. At
    // 1080p that is roughly 0.9 GB per channel on the runner's disk.
    return Math.max(
      300,
      (settings?.preEventSec ?? 8) + (settings?.postEventSec ?? 10) + 900,
    );
  }

  /**
   * Re-cuts queued spikes from the live ring buffer. Without this a rebuild of
   * a moment from a channel that is still live has to wait for the archive VOD,
   * which only appears when the stream ends - possibly days later.
   */
  private async drainLiveRebuilds(): Promise<void> {
    let queue: Awaited<ReturnType<ClipforgeApi["queue"]>>;
    try {
      queue = await this.api.queue(3);
    } catch {
      return;
    }
    const now = Date.now() / 1000;
    const window = this.bufferSeconds() - 20;
    for (const spike of queue.spikes) {
      if (this.stopping) return;
      // Tail of the buffer is still being written; skip moments the recorder
      // cannot cover yet.
      if (now - spike.ts_unix > window) {
        // Say why a re-cut is not happening now: an old moment on a live
        // channel can only be cut once the archive VOD exists.
        if (spike.analyze_json && !this.deferredRebuilds.has(spike.id)) {
          if (this.deferredRebuilds.size > 500) this.deferredRebuilds.clear();
          this.deferredRebuilds.add(spike.id);
          log(
            `rebuild ${spike.id}: moment is ${Math.round((now - spike.ts_unix) / 60)} min old and the ` +
              `live buffer covers ${Math.round(window / 60)} min - waiting for the archive VOD`,
          );
        }
        continue;
      }
      // Only re-cuts: a fresh spike is already being handled by the detector.
      if (!spike.analyze_json) continue;
      const login = spike.channel_login.toLowerCase();
      const state = this.states.get(login);
      if (!state || !this.recorders.has(login)) continue;

      log(`rebuild ${spike.id}: re-cutting ${login} from the live buffer`);
      void this.captureLive(state, spike.ts_unix, spike.id, { waitForTail: false });
    }
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

      // The cap applies for the whole run, not just at startup: a long run can
      // see more channels go live than MAX_CHANNELS allows. It is the workflow's
      // limit only - see the startup note about settings.maxChannels.
      const cap = this.cfg.maxChannels;
      let capped = false;
      for (const channel of live.channels) {
        if (channel.capture_mode === "none") continue;
        if (this.states.size >= cap) {
          capped = true;
          break;
        }
        this.addChannel(channel);
      }
      if (capped && !this.capLogged) {
        this.capLogged = true;
        log(`channel cap ${cap} reached - ignoring any further live channels this run`);
      }
      if (live.channels.some((c) => c.is_live === 1)) this.lastLiveAt = Date.now();

      // A channel paused (monitor = 0) or removed mid-run must stop counting.
      for (const login of [...this.states.keys()]) {
        if (monitored.has(login)) continue;
        this.states.delete(login);
        if (this.joined.delete(login)) this.ws?.send(`PART #${login}`);
        log(`stopped collecting #${login} (paused or removed)`);
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
      // A failed refresh is not evidence that nothing is live, so it must not
      // count towards the idle exit.
      this.lastLiveAt = Date.now();
      log(`live reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Turns a just-detected spike into a finished clip from the ring buffer, in
   * the same process, with no VOD dependency.
   */
  private async captureLive(
    state: ChannelState,
    ts: number,
    spikeId: string,
    options: { waitForTail?: boolean } = {},
  ): Promise<void> {
    const recorder = this.recorders.get(state.login);
    const settings = this.settings;
    if (!recorder || !settings) return;
    if (this.liveRenders >= 2) {
      // The ring buffer still holds this moment for a couple of minutes, so the
      // spike waits here instead of being dropped to the VOD path (which cannot
      // help until the stream ends).
      if (this.pendingLive.length < 20) {
        this.pendingLive.push({ login: state.login, ts, spikeId });
        log(`live render slots busy - queued ${state.login} moment for the next free slot`);
      } else {
        log("live render backlog full - spike left for the VOD renderer");
      }
      return;
    }
    this.liveRenders++;

    let workDir: string | null = null;
    let snapDir: string | null = null;
    try {
      // The analyser decides where the clip starts and ends, so capture enough
      // footage around the peak for it to choose from rather than just the
      // configured pre/post roll. A re-cut that was asked to make the clip
      // longer needs more than the default 15s either side, or its beats run
      // past the end of the snapshot and every cut collapses onto the last few
      // seconds of the source.
      const wanted = Math.max(settings.clipDurationSec ?? 30, 20);
      const lead = Math.max(settings.preEventSec, 15, Math.ceil(wanted * 0.6));
      const tail = Math.max(settings.postEventSec, 15, Math.ceil(wanted * 0.6));

      // Wait for the post-roll to be written into the buffer. A rebuild is
      // already minutes old, so there is nothing to wait for.
      if (options.waitForTail !== false) await sleep((tail + 2) * 1000);

      // The segment writer can be a couple of seconds behind, so give the
      // buffer a few chances before declaring the moment uncuttable.
      let snap = await recorder.snapshot(ts, lead, tail);
      for (let attempt = 0; !snap && attempt < 3; attempt++) {
        await sleep(3_000);
        snap = await recorder.snapshot(ts, lead, tail);
      }
      if (!snap) {
        log(`no buffer coverage for ${state.login} - moment left for a later pass`);
        return;
      }
      snapDir = snap.workDir;

      // The snapshot's wall-clock anchor is estimated from segment times, so
      // keep the offsets inside the footage that was actually written.
      const startInSnap = Math.max(
        0,
        Math.min(ts - lead - snap.startSec, Math.max(0, snap.durationSec - 3)),
      );
      // 30s keeps Whisper inside its reliable input size and still leaves
      // roughly fifteen seconds either side of the spike for the beat plan.
      const window = Math.min(30, Math.max(2, snap.durationSec - startInSnap));

      workDir = await mkdtemp(path.join(tmpdir(), "clipforge-live-"));
      // Where the analysed window starts on the spike's own timeline. The
      // analyser uses it to place audio peaks and speech on the footage.
      const windowStartSec = snap.startSec + startInSnap - ts;
      const analysis = await analyseLocal(
        this.api,
        spikeId,
        snap.file,
        startInSnap,
        window,
        settings.frameSampleFps,
        workDir,
        windowStartSec,
      );

      if (!analysis) {
        log(`live analysis produced nothing for ${state.login} - no usable frames or audio in the snapshot`);
        return;
      }
      if (analysis.skipped) {
        const score = analysis.analysis?.qualityScore;
        log(
          `live analysis skipped ${state.login}: ${analysis.reason ?? "below the quality floor"}` +
            (score === undefined ? "" : ` (score ${score}, floor ${settings.minQualityScore})`),
        );
        return;
      }
      if (!analysis.clipId || !analysis.clip) {
        log(`live analysis produced no clip for ${state.login}`);
        return;
      }
      if (!analysis.transcript) {
        log(
          `no speech transcript for ${state.login} - clip gets the caption card, not spoken subtitles` +
            (analysis.sttError ? `: ${analysis.sttError.slice(0, 240)}` : ""),
        );
      }

      await produceClipFromFile({
        api: this.api,
        clip: analysis.clip,
        sourceFile: snap.file,
        sourceStartSec: snap.startSec,
        sourceDurationSec: snap.durationSec,
        settings,
        workDir,
        transcript: analysis.transcript,
        beats: analysis.beats,
        captions: analysis.captions,
        // A live moment has no archive VOD to re-cut from; keeping the footage
        // is what makes its re-cuts work now instead of when the stream ends.
        saveSource: true,
      });
    } catch (err) {
      log(`live capture failed for ${state.login}: ${err instanceof Error ? err.message : String(err)}`);
      // Hand the moment back so the scheduled renderer can try the VOD path.
      await this.api.setSpikeStatus(spikeId, "queued").catch(() => {});
    } finally {
      this.liveRenders--;
      if (workDir) await cleanupWorkDir(workDir);
      // Each snapshot is a concatenated copy of the moment; on a stream that
      // runs for days, leaking one per clip fills the runner's disk.
      if (snapDir) await cleanupWorkDir(snapDir);
      this.runPendingLive();
    }
  }

  /** Starts the next backlogged live cut now that a slot is free. */
  private runPendingLive(): void {
    if (this.stopping) return;
    while (this.liveRenders < 2 && this.pendingLive.length) {
      const next = this.pendingLive.shift()!;
      const state = this.states.get(next.login);
      if (!state || !this.recorders.has(next.login)) {
        log(`dropped backlogged moment for ${next.login} - its buffer is gone, left for the VOD pass`);
        continue;
      }
      // captureLive increments liveRenders synchronously before it first awaits,
      // so the loop cannot overfill the slots.
      void this.captureLive(state, next.ts, next.spikeId);
    }
  }

  /** Runs the detector on every channel and posts qualifying events. */
  private async detectAll(): Promise<void> {
    // One pass at a time. The interval fires every 5s; if a request stalls for
    // its full deadline, overlapping passes would otherwise queue up behind it.
    if (!this.settings || this.detecting || this.stopping) return;
    this.detecting = true;
    try {
      const cfg = configFromSensitivity(this.settings.spikeSensitivity);
      const now = Date.now() / 1000;

      for (const state of this.states.values()) {
        // With no history the baseline is 0, so the first busy second after
        // joining looks like an intensity-100 moment and produced a clip of
        // nothing. Give the window a minute to fill before judging it.
        if (now - state.joinedAt < DETECT_WARMUP_SEC) continue;
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
          this.lastDetectionAt = now;
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
    } catch (err) {
      // Never let one malformed burst kill the 5s detection timer.
      log(`spike detection pass failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.lastDetectPassAt = Date.now() / 1000;
      this.detecting = false;
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
