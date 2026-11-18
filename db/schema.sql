-- ClipForge schema (Cloudflare D1 / SQLite)
-- Write economy matters: D1 free tier is 10k row writes/day. Chat is aggregated
-- into one row per channel per minute rather than one row per message.

CREATE TABLE IF NOT EXISTS channels (
  id              TEXT PRIMARY KEY,          -- Twitch broadcaster id
  login           TEXT NOT NULL UNIQUE,      -- lowercase login
  display_name    TEXT NOT NULL,
  avatar_url      TEXT,
  description     TEXT,
  monitor         INTEGER NOT NULL DEFAULT 1,
  source          TEXT NOT NULL DEFAULT 'manual', -- manual | discovered
  is_live         INTEGER NOT NULL DEFAULT 0,
  title           TEXT,
  game_name       TEXT,
  game_id         TEXT,
  viewer_count    INTEGER,
  started_at      TEXT,
  last_live_at    TEXT,
  last_polled_at  TEXT,
  capture_mode    TEXT NOT NULL DEFAULT 'vod', -- vod | chat_only | none
  moments         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channels_live ON channels(is_live, monitor);

-- One row per channel per minute. buckets_json holds 12 x 5s counts so the live
-- graph keeps 5s resolution while costing a single row write per minute.
CREATE TABLE IF NOT EXISTS chat_minutes (
  channel_id      TEXT NOT NULL,
  ts_minute       INTEGER NOT NULL,
  msg_count       INTEGER NOT NULL DEFAULT 0,
  unique_chatters INTEGER NOT NULL DEFAULT 0,
  emote_count     INTEGER NOT NULL DEFAULT 0,
  repeat_count    INTEGER NOT NULL DEFAULT 0,
  caps_ratio      REAL NOT NULL DEFAULT 0,
  emotes_json     TEXT,
  buckets_json    TEXT,
  samples_json    TEXT,
  PRIMARY KEY (channel_id, ts_minute)
);

CREATE INDEX IF NOT EXISTS idx_chat_minutes_ts ON chat_minutes(ts_minute DESC);

CREATE TABLE IF NOT EXISTS spikes (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL,
  channel_login   TEXT NOT NULL,
  detected_at     TEXT NOT NULL,
  ts_unix         INTEGER NOT NULL,
  message_count   INTEGER NOT NULL,
  baseline_rate   REAL NOT NULL,
  peak_rate       REAL NOT NULL,
  unique_chatters INTEGER NOT NULL,
  intensity       REAL NOT NULL,
  z_score         REAL NOT NULL,
  features_json   TEXT,
  samples_json    TEXT,
  status          TEXT NOT NULL DEFAULT 'queued', -- queued|analyzing|rendering|done|failed|skipped
  merged_into     TEXT,
  ai_json         TEXT,
  ai_provider     TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spikes_ts ON spikes(ts_unix DESC);
CREATE INDEX IF NOT EXISTS idx_spikes_channel ON spikes(channel_id, ts_unix DESC);
CREATE INDEX IF NOT EXISTS idx_spikes_status ON spikes(status);

CREATE TABLE IF NOT EXISTS clips (
  id            TEXT PRIMARY KEY,
  spike_id      TEXT,
  channel_id    TEXT,
  channel_login TEXT,
  channel_name  TEXT,
  title         TEXT,
  caption       TEXT,
  description   TEXT,
  hashtags_json TEXT,
  game_name     TEXT,
  stream_title  TEXT,
  quality_score INTEGER,
  funniness     INTEGER,
  intensity     REAL,
  category      TEXT,
  duration_ms   INTEGER,
  width         INTEGER,
  height        INTEGER,
  r2_key        TEXT,
  thumb_key     TEXT,
  bytes         INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|rendering|ready|failed
  error         TEXT,
  provider      TEXT,
  model         TEXT,
  source_ts     INTEGER,
  start_offset  REAL,
  end_offset    REAL,
  transcript    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clips_created ON clips(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clips_quality ON clips(quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_clips_status ON clips(status);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_log (
  id     TEXT PRIMARY KEY,
  ts     INTEGER NOT NULL,
  kind   TEXT NOT NULL,   -- d1_write | r2_bytes | render_sec | ai_call
  amount REAL NOT NULL,
  meta   TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts DESC);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,   -- collector | renderer | discovery
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,
  detail      TEXT
);
