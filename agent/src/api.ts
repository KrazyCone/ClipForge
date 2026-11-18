import type { AgentConfig } from "./config.js";

export interface AgentSettings {
  spikeSensitivity: number;
  maxChannels: number;
  clipDurationSec: number;
  preEventSec: number;
  postEventSec: number;
  minQualityScore: number;
  frameSampleFps: number;
  aspectRatio: "9:16" | "1:1" | "16:9";
  subtitleStyle: "bold" | "clean" | "karaoke";
  webcamFocus?: boolean;
  autoProcess: boolean;
  storageLimitMb: number;
}

export interface QueueSpike {
  id: string;
  channel_id: string;
  channel_login: string;
  ts_unix: number;
  intensity: number;
  message_count: number;
  baseline_rate: number;
  peak_rate: number;
  unique_chatters: number;
  features_json: string | null;
  samples_json: string | null;
  stream_title: string;
  game_name: string;
  display_name: string;
  capture_mode: string;
}

export interface QueueClip {
  id: string;
  spike_id: string | null;
  /** the spike's stored analysis, which carries the beat plan for old clips */
  spike_ai_json?: string | null;
  channel_id: string | null;
  channel_login: string | null;
  channel_name: string | null;
  source_ts: number | null;
  start_offset: number | null;
  end_offset: number | null;
  duration_ms: number | null;
  title: string | null;
  caption: string | null;
  quality_score: number | null;
  game_name: string | null;
  stream_title: string | null;
  transcript: string | null;
  /** detected webcam crop, `{ visible, region, size, box }` */
  webcam_json?: string | null;
  status: string;
  created_at?: string;
}

export interface AnalyzedClip {
  id: string;
  caption: string | null;
  title: string | null;
  source_ts: number | null;
  start_offset: number | null;
  end_offset: number | null;
  transcript: string | null;
  webcam_json?: string | null;
}

export interface AnalyzeBeat {
  startSec: number;
  endSec: number;
  score: number;
}

export interface TimedCaption {
  startSec: number;
  endSec: number;
  text: string;
}

export interface AnalyzePayload {
  frames?: string[];
  audioBase64?: string;
  transcript?: string;
  /** start of the sampled footage, relative to the spike peak */
  windowStartSec?: number;
  /** dBFS per bucket across the sampled footage */
  loudness?: number[];
  loudnessBucketSec?: number;
}

export interface AnalyzeResult {
  ok: boolean;
  clipId?: string;
  skipped?: boolean;
  reason?: string;
  transcript?: string;
  sttError?: string | null;
  beats?: AnalyzeBeat[];
  captions?: TimedCaption[];
  clip?: AnalyzedClip;
  analysis?: {
    qualityScore: number;
    funniness: number;
    interesting: boolean;
    category: string;
    provider: string;
  };
}

export interface QueueResponse {
  settings: AgentSettings;
  spikes: QueueSpike[];
  clips: QueueClip[];
  channels: { id: string; login: string; display_name: string; is_live: number; capture_mode: string }[];
  aiConfigured: boolean;
}

export interface MinutePayload {
  tsMinute: number;
  msgCount: number;
  uniqueChatters: number;
  emoteCount: number;
  repeatCount: number;
  capsRatio: number;
  emotes: string[];
  buckets: number[];
  samples: string[];
}

export interface SpikePayload {
  tsUnix: number;
  messageCount: number;
  baselineRate: number;
  peakRate: number;
  uniqueChatters: number;
  intensity: number;
  zScore: number;
  features: Record<string, unknown>;
  samples: string[];
}

export class ClipforgeApi {
  constructor(private cfg: AgentConfig) {}

  /**
   * Every call here runs from a timer (detection every 5s, drain every 3min),
   * and `fetch` has no deadline of its own. A single request that never answers
   * used to hang the whole loop silently: chat and the heartbeat kept running
   * while no spike could ever be emitted again. Each call gets a deadline now.
   */
  private async request(
    path: string,
    init: RequestInit = {},
    timeoutMs = 30_000,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cfg.ingestToken) headers.set("authorization", `Bearer ${this.cfg.ingestToken}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${this.cfg.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async queue(limit = 3): Promise<QueueResponse> {
    const res = await this.request(`/api/queue?limit=${limit}`);
    if (!res.ok) throw new Error(`queue ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as QueueResponse;
  }

  /** Refresh Twitch live status server-side and return the monitored channels. */
  async refreshLive(): Promise<{
    channels: { id: string; login: string; display_name: string; is_live: number; capture_mode: string }[];
  }> {
    const res = await this.request("/api/twitch/refresh", { method: "POST" }, 60_000);
    if (!res.ok) throw new Error(`refresh ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as {
      channels: { id: string; login: string; display_name: string; is_live: number; capture_mode: string }[];
    };
  }

  async ingest(body: unknown): Promise<{ ok: boolean; spikeId?: string; merged?: boolean }> {
    const res = await this.request("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`ingest ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as { ok: boolean; spikeId?: string; merged?: boolean };
  }

  async setSpikeStatus(id: string, status: string): Promise<void> {
    await this.request(
      `/api/spikes/${id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      },
      20_000,
    );
  }

  async failClip(id: string, error: string): Promise<void> {
    await this.request(
      `/api/clips/${id}/status`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "failed", error }),
      },
      20_000,
    ).catch(() => {});
  }

  async analyze(id: string, payload: AnalyzePayload): Promise<AnalyzeResult> {
    // Frames + Whisper + the LLM can take a while, but a hung analysis must not
    // hold a live render slot for the rest of the run.
    const res = await this.request(
      `/api/spikes/${id}/analyze`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      180_000,
    );
    if (!res.ok) throw new Error(`analyze ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as AnalyzeResult;
  }

  async uploadClip(
    clipId: string,
    video: Buffer,
    thumb: Buffer | null,
    meta: Record<string, unknown>,
  ): Promise<{ ok: boolean; mediaUrl?: string }> {
    const form = new FormData();
    form.set("clipId", clipId);
    form.set("file", new Blob([new Uint8Array(video)], { type: "video/mp4" }), "clip.mp4");
    if (thumb) {
      form.set("thumb", new Blob([new Uint8Array(thumb)], { type: "image/jpeg" }), "thumb.jpg");
    }
    form.set("meta", JSON.stringify(meta));
    const res = await this.request("/api/clips/upload", { method: "POST", body: form }, 240_000);
    if (!res.ok) throw new Error(`upload ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as { ok: boolean; mediaUrl?: string };
  }

  async recordRun(kind: string, status: string, detail: string): Promise<void> {
    try {
      await this.ingest({ login: "__run__", run: { kind, status, detail } });
    } catch {
      // A run record is nice-to-have; never fail the job over it.
    }
  }
}
