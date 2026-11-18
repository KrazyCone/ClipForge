# ClipForge — architecture, free-tier budget, and honest limits

This document answers the research question first (which free services can actually
run this), then explains how the code is organised and how to deploy it.

Everything below was checked against the providers' own documentation in November 2026.
Quotas change; re-verify before relying on one.

---

## 1. Why not Firebase

Firebase was evaluated and rejected for one reason that has nothing to do with
quota size: **on the free Spark plan, Cloud Storage for Firebase and Cloud Functions
are not available at all.**

- Cloud Storage for Firebase has required the pay-as-you-go **Blaze** plan since
  September 2024 (enforced for existing default buckets from February 2026). No
  bucket, not even a legacy `*.appspot.com` one, is readable or writable on Spark.
- Cloud Functions for Firebase is Blaze-only. Spark lists Functions as "not applicable".
- Spark would otherwise be a fine fit for 1–2 users: 50k Firestore reads/day, 20k
  writes/day, 1 GiB stored, 10 GB/month egress, Hosting with 360 MB/day transfer.

This application needs exactly the two things Spark does not have: somewhere to put
MP4 files, and a server that holds the Twitch client secret. Blaze requires a payment
method on file and has no built-in spending ceiling, which violates the "never
silently incur costs" requirement. So: **not Firebase.**

The stack below provides the same capabilities (managed SQL, object storage,
server-side API, sign-in) on a plan that genuinely does not ask for a card.

---

## 2. The stack, and what each piece handles

| Layer | Service | Free allowance | Used for |
|---|---|---|---|
| Web app + API | **Freebuff Sites** (Cloudflare Workers + static assets) | 100k invocations/month, 5,000 s server CPU/month, 500 s/day | Dashboard, all API routes, Twitch calls, AI calls, signing machine tokens |
| Database | **Cloudflare D1** (SQLite) | 100 MB total, 100k row writes/month, 10k/day, 50M reads/month | Channels, per-minute chat aggregates, spikes, clips, settings, usage |
| Clip storage | **Cloudflare R2** | 1 GB total, 2,500 Class A ops/day, 250k Class B ops/month | MP4 clips, JPEG thumbnails |
| Chat collection | **GitHub Actions** (scheduled workflow) | Unmetered on a public repo; 2,000 min/month private | Persistent IRC connections, spike detection |
| Video processing | **GitHub Actions** + **FFmpeg** | Same as above | VOD segment extraction, frame/audio sampling, vertical render, subtitle burn-in |
| Twitch data | **Twitch Helix + public IRC** | Free, 800 points/min per client id | Channel discovery, live status, VOD listing, chat |
| AI (optional) | **Cloudflare Workers AI** | ~10,000 Neurons/day | LLM moment assessment + captions, Whisper STT, vision frame description |
| AI (always on) | **Built-in heuristic scorer** | Free, local | Quality score, category, captions from chat signals |

No service above requires a credit card. No paid resource is created by deploying this
project, and no code path can upgrade a plan.

### Why rendering is not on Workers

Cloudflare Workers cannot run FFmpeg. They have no native binaries, no writable
persistent filesystem, and a per-request CPU budget measured in milliseconds. A 25-second
1080×1920 H.264 encode is seconds of CPU. Any claim that "the whole pipeline runs
serverless" would be false.

GitHub Actions is the free compute that can do it: a standard `ubuntu-latest` runner has
FFmpeg available, runs for up to 6 hours, and on a **public** repository the minutes are
unmetered. That is the entire video-processing budget. It is a scheduled cloud job, not
software on your computer.

---

## 3. Live clipping: how it works, and where it stops

The rolling buffer lives **inside the collector process**, not in Cloudflare:

- For every live channel, ffmpeg copies the public live HLS into 2-second MPEG-TS
  segments on the runner's temp disk. Stream copy only — no re-encode — so the cost is
  disk I/O. A sweep deletes segments older than the window (~3 minutes by default).
- When the detector fires, the segments covering `moment − preEvent` to
  `moment + postEvent` are concatenated into one local file, sampled for frames and
  audio, assessed, and rendered **in the same process**. The clip reaches R2 seconds
  later — while the stream is still live.
- If the buffer has no coverage (run just started, recorder died), the spike is handed
  back to the scheduled renderer, which cuts from the archive VOD instead.

Why not in a Worker: Workers have no long-lived process, no disk, and a CPU budget in
milliseconds. Why not on R2: 1 GB cannot hold a rolling window for several 1080p
channels. The runner's 14 GB of ephemeral disk can, cheaply, which is why this runs there.

The recording is the same public HLS the Twitch web player plays — no DRM or
access-control bypass. It is still a recording, so only point it at channels you own or
have permission to clip.

### VOD fallback

When live capture is unavailable, the renderer finds the broadcaster's **archive VOD**
covering the timestamp and seeks to `moment − preEventSec`. That path still works for a
stream that has already ended, and is the only path when no collector is running.

**Restrictions, stated plainly:**

- **Coverage gaps.** A collector run lasts 5h45m and cron starts one every 6 hours, so
  there is ~15 minutes without recording per rotation, plus GitHub's cron delay. Chat is
  not recorded in that gap either, so moments there are missed entirely. Only an
  always-on host (e.g. an Oracle Cloud Always Free ARM VM) removes the gap; the code is
  structured to run there unchanged.
- **Disk.** ~135 MB per channel per 3 minutes at 1080p60. Five channels stays under 1 GB
  inside the runner's 14 GB.
- **CPU.** One render on two cores takes roughly 30–60 s. Live rendering is capped at two
  concurrent clips; beyond that the VOD renderer picks the work up.
- **VOD carve-out.** If the broadcaster has **Store past broadcasts** disabled, only the
  live path can produce clips, and only while a collector run is active.
- **Compliance.** Live capture records the public HLS a viewer receives. Use it for
  channels you own or have permission to clip.

---

## 4. Detection engine

`lib/spike.ts` — shared by the collector and the API, dependency-free.

- Per-second message counts over a 68-second window.
- Baseline = **median** of the preceding 60 s, spread = **MAD** (median absolute
  deviation) scaled by 1.4826. Median/MAD are used instead of mean/σ because the spikes
  being hunted would otherwise inflate the baseline and hide themselves.
- Robust z-score `(mean − median) / σ`, plus a ratio test `(peak+1)/(baseline+1)` so a
  quiet channel is never compared against a busy one.
- Signals scored into a 0–100 intensity: z-score, ratio, absolute volume (log-capped),
  emote ratio, laughter-token ratio, chatter diversity, repeated-phrase ratio (Jaccard
  similarity ≥ 0.67 against the previous 12 messages), caps ratio, burstiness
  (variance/mean), and acceleration.
- Fires only when intensity ≥ threshold **and** `z ≥ minZ` **and** `ratio ≥ minRatio`
  **and** the burst has at least `minMessages` messages. Both statistical and
  proportional evidence are required: a 30 % bump in a 90 msg/s channel is not a moment,
  and a 2 msg/s trickle is not either. σ is floored at `sqrt(baseline)` because message
  counts cannot be less noisy than Poisson.
- Sensitivity slider (0–100) maps to those three thresholds in `configFromSensitivity`.
- Deduplication: the API folds a new spike into an existing one within 90 s unless the new
  burst is >35 % stronger, so one moment cannot produce two clips.

`lib/spike.test.ts` covers the quiet-channel burst, the busy-channel non-event, steady
chat, and the merge rule.

---

## 5. Analysis

Two providers, and the one actually used is recorded on every clip (`provider` column),
so the dashboard never implies a model looked at something it did not.

1. **`heuristic`** — always available, no key, no cost. Scores quality from the chat
   features and writes category-appropriate titles/captions.
2. **`workers-ai`** — enabled when `CF_ACCOUNT_ID` + `CF_AI_TOKEN` are set. Uses:
   - `@cf/meta/llama-3.1-8b-instruct-fast` for the moment assessment and captions
     (the non-`-fast` variant was deprecated on 2026-05-30),
   - `@cf/openai/whisper-large-v3-turbo` for transcription,
   - `@cf/meta/llama-3.2-11b-vision-instruct` for sampled-frame descriptions.

Frames are sampled at `frameSampleFps` (default 0.5) and capped at 3 per moment; audio is
16 kHz mono and capped at ~4.5 MB. The free daily neuron allowance is small — roughly a
few dozen analysed moments per day — so the pipeline is deliberately frugal.

Without Workers AI credentials the system **cannot see the video**. It still uses chat
and the visual sampler is skipped. The UI states this ("heuristic only").

---

## 6. Editing

`agent/src/renderer.ts` and `agent/src/ffmpeg.ts`:

- Seek to `moment − preEvent`, take `clipDurationSec` (bounded by the analyser's window).
- 1080×1920 (or 1080×1080 / 1920×1080) H.264 High, `yuv420p`, `+faststart`, AAC 128 kbps.
- **Framing:** default `blur` keeps the *entire* source frame visible, centred, over a
  blurred fill. Nothing is cut off, which matters for gameplay HUDs. Hard cropping to
  centre/left/right is implemented but off by default because a blind crop can remove the
  killfeed or the minimap.
- **Subtitles:** ASS, 62 px DejaVu Sans bold, 5 px outline, bottom margin 220 px so it
  clears TikTok/Reels UI. With a transcript, phrases are timed evenly across the clip;
  Whisper's word timings are not used for karaoke highlighting yet. Without a transcript,
  the AI caption is burned in as a top card for the first ~3 s.
- Audio is preserved (re-encoded to AAC, never replaced).

**Not implemented, deliberately:** silence/pause removal and auto-zoom. Both need an extra
analysis+encode pass; on a 2,000-minute monthly budget (private repo) or a 30-minute job
timeout they are the first things that would make the pipeline flaky. The detector already
trims to the interesting window, which removes most dead time.

---

## 7. Storage and quota discipline

| Guard | Behaviour |
|---|---|
| `maxChannels` (default 3) | Hard cap in the add-channel route. One live channel costs ~1,730 writes/day (1,440 chat-minute rows + 288 live-status refreshes), so 5 channels ≈ 8,600 of the 10,000/day budget — that is the practical ceiling |
| 1 row per channel per minute | Chat is aggregated; 12× 5-second buckets live in a JSON column, so 5 s graph resolution still costs one write |
| 26-hour retention | `chat_minutes` older than 26 h is pruned on every Twitch refresh |
| `storageLimitMb` | Surfaced in Settings and the sidebar; clips are counted from real `SUM(bytes)` |
| Clip size cap | Upload rejects >40 MB |
| 30 s spike dedupe window | Prevents duplicate clips for the same moment |
| Graceful AI fallback | No credentials → local scorer, never an error |

The dashboard's **Resources** panel shows real R2 bytes, real D1 row counts and today's
write count against the free ceilings.

---

## 8. Security

- Twitch secret, ingest token and AI token live in Sites Secrets and never reach the
  browser. All Twitch calls are server-side.
- `/api/ingest`, `/api/queue`, `/api/spikes/:id/analyze`, `/api/spikes/:id` and
  `/api/clips/upload` require `Authorization: Bearer $INGEST_TOKEN`, compared in
  constant time.
- `/api/health` reports when `INGEST_TOKEN` is missing, and `/api/queue` is
  unauthenticated only while no token exists (so a fresh deploy can bootstrap).
- Input validation on every write path: login regex, numeric bounds on settings, clamped
  chat counters, path traversal rejection on `/api/media`.
- R2 is not public; playback and download go through the Worker with Range support.

**Sign-in:** the dashboard uses Sign in with Freebuff (`@freebuff/auth`). The root layout
refuses to render the shell without a session, every browser-facing API route calls
`getUser()` and returns 401 when it is null, and `proxy.ts` refreshes an expired session
before pages render. Verified: signed-out `/` shows the gate, `/api/channels` and
`/api/settings` return 401, and `/auth/freebuff/signin` redirects to the OIDC issuer with
the registered callback. There is no client secret to leak.

Machine endpoints are separate: the collector and renderer authenticate with
`INGEST_TOKEN`, so they never need a browser session.

---

## 9. Deployment

### App (once)

1. `sites_create` → `sites_add_storage` (D1 `DB`, R2 `FILES`) → `sites_prepare_next` →
   `sites_deploy`. Preview and Production are separate environments with separate data.
2. Open `https://<site>/api/setup` and `POST` to it once. It runs `db/schema.sql`
   (idempotent `CREATE TABLE IF NOT EXISTS`).
3. Add secrets: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `INGEST_TOKEN`
   (`openssl rand -hex 32`). Optionally `CF_ACCOUNT_ID`, `CF_AI_TOKEN`.
4. Redeploy so the bindings and secrets are active. `/api/health` should report
   `ok: true` and no warnings.

### Workers (once)

Add repository secrets `CLIPFORGE_BASE_URL` and `INGEST_TOKEN`
(and optionally `TWITCH_BOT_LOGIN`/`TWITCH_BOT_TOKEN` for a chat token).

`TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` are **not** required here: the agent asks the
site for archive VODs via `GET /api/twitch/videos` using `INGEST_TOKEN`, so the Twitch
credentials exist in exactly one place. Supplying them as worker secrets still works and
skips that hop.

- `.github/workflows/collect.yml` — every 30 min, 25-minute chat collection run.
- `.github/workflows/render.yml` — every 10 min, renders queued clips.

Both are `workflow_dispatch`-able for a manual run. **Make the repository public** or the
collector's duty cycle will exhaust the 2,000 private-repo minutes.

### Local development (optional — the product does not need it)

```bash
npm install
npm run dev        # http://localhost:3000, uses the local Wrangler bindings
npm test           # spike detector unit tests
cd agent && npm install && npm run build
```

Local runs use the local D1/R2 from `freebuff.wrangler.jsonc`; they never touch the
hosted database.

---

## 10. What is real, and what is not

**Real:** Twitch discovery and live status (Helix), chat over Twitch IRC, per-minute
aggregation and 5-second graph resolution, the adaptive detector, spike persistence,
Workers AI analysis when configured, live ring-buffer capture with in-process rendering,
VOD fallback, FFmpeg vertical rendering, subtitle burn-in, R2 storage, download, delete,
re-caption, re-render.

**Not real yet / limited:**

- Live capture has a ~15 minute gap per 6-hour collector rotation (§3).
- Clicking **Reprocess** only requeues; nothing happens until the render workflow runs.
- Vision analysis is only as good as the free vision model and 3 sampled frames.
- Subtitle timing is phrase-level, not word-level.
- Live rendering starts ~10 s after the spike (post-roll wait) and finishes within a
  minute or two; the VOD fallback path can take up to ~10 minutes.
- Sign-in identifies the operator but the data model is single-tenant: every signed-in
  Freebuff user sees the same channels and clips. That is deliberate for a personal tool;
  multi-tenant data would need a `user_id` column and scoped queries.
- End-to-end rendering has not been exercised against a real Twitch VOD in this
  environment (no Twitch credentials were available). The code paths are implemented and
  typechecked; the first real spike is the true test.
