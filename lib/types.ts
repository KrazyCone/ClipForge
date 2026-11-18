export interface Channel {
  id: string;
  login: string;
  display_name: string;
  avatar_url: string | null;
  description: string | null;
  monitor: number;
  source: string;
  is_live: number;
  title: string | null;
  game_name: string | null;
  game_id: string | null;
  viewer_count: number | null;
  started_at: string | null;
  last_live_at: string | null;
  last_polled_at: string | null;
  capture_mode: string;
  moments: number;
  created_at: string;
}

export interface ChatMinute {
  channel_id: string;
  ts_minute: number;
  msg_count: number;
  unique_chatters: number;
  emote_count: number;
  repeat_count: number;
  caps_ratio: number;
  emotes_json: string | null;
  buckets_json: string | null;
  samples_json: string | null;
}

export interface Spike {
  id: string;
  channel_id: string;
  channel_login: string;
  detected_at: string;
  ts_unix: number;
  message_count: number;
  baseline_rate: number;
  peak_rate: number;
  unique_chatters: number;
  intensity: number;
  z_score: number;
  features_json: string | null;
  samples_json: string | null;
  status: string;
  merged_into: string | null;
  ai_json: string | null;
  ai_provider: string | null;
  /** per-spike settings for a one-off rebuild; cleared once consumed */
  analyze_json: string | null;
  created_at: string;
}

export interface Clip {
  id: string;
  spike_id: string | null;
  channel_id: string | null;
  channel_login: string | null;
  channel_name: string | null;
  title: string | null;
  caption: string | null;
  description: string | null;
  hashtags_json: string | null;
  game_name: string | null;
  stream_title: string | null;
  quality_score: number | null;
  funniness: number | null;
  intensity: number | null;
  category: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  r2_key: string | null;
  thumb_key: string | null;
  bytes: number | null;
  status: string;
  error: string | null;
  provider: string | null;
  model: string | null;
  source_ts: number | null;
  start_offset: number | null;
  end_offset: number | null;
  transcript: string | null;
  /** detected webcam crop, `{ visible, region, size, box }` */
  webcam_json: string | null;
  /** derived: the source moment is queued for a one-off re-cut */
  rebuild_pending?: number | null;
  created_at: string;
  updated_at: string;
}

export interface AppSettings {
  spikeSensitivity: number;        // 0-100, higher = more clips
  maxChannels: number;
  clipDurationSec: number;
  preEventSec: number;
  postEventSec: number;
  minQualityScore: number;
  frameSampleFps: number;
  aspectRatio: "9:16" | "1:1" | "16:9";
  subtitleStyle: "bold" | "clean" | "karaoke";
  /** standing free-text direction applied to every clip's pick, title and caption */
  clipDirection: string;
  /** stack an enlarged webcam band above the gameplay when a face cam is found */
  webcamFocus: boolean;
  autoProcess: boolean;
  discoveryEnabled: boolean;
  storageLimitMb: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  spikeSensitivity: 55,
  maxChannels: 3,
  clipDurationSec: 24,
  preEventSec: 8,
  postEventSec: 10,
  minQualityScore: 55,
  frameSampleFps: 0.5,
  aspectRatio: "9:16",
  subtitleStyle: "bold",
  clipDirection: "",
  webcamFocus: true,
  autoProcess: true,
  discoveryEnabled: true,
  storageLimitMb: 900,
};
