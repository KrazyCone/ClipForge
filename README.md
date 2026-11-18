# ClipForge

Autonomous Twitch clipping. ClipForge watches live chat, detects the moments where chat
breaks pattern, samples the stream's video and audio, scores the moment, and renders a
vertical clip with burned-in captions — then files it in a web dashboard.

Everything runs in the cloud. There is nothing to install on your computer, and no paid
API is required.

**Live:** https://vyral-stzd3l-preview.freebuff.page (sign in with Freebuff)

> The site's hostname is `vyral-stzd3l` because it was created before the rename. It is
> cosmetic — the app, the code and every setting now say ClipForge.

**Getting started:** [SETUP.md](SETUP.md) walks from zero to your first clip.
Design rationale, free-tier maths and limitations: [ARCHITECTURE.md](ARCHITECTURE.md).

---

## How it fits together

```
Twitch IRC ──► collector (GitHub Actions) ──► POST /api/ingest
                     │                              │
                     │ adaptive spike detection      ▼
                     │                        D1: spikes, chat_minutes
                     ▼
        live HLS ring buffer (~3 min, temp disk)
                     │
                     ├─► sample frames + audio ──► POST /api/spikes/:id/analyze
                     │                                        │
                     │                              Workers AI or heuristic
                     │                                        │
                     └─► vertical render + subtitles ──► R2 ──► dashboard

Fallback (run gap, recorder failure, finished stream):
renderer (GitHub Actions) ──► archive VOD ──► same analyze + render path
```

- **App / API / dashboard** — Next.js 16 on Freebuff Sites (Cloudflare Workers).
- **Database** — Cloudflare D1 (SQLite). Chat is aggregated to one row per channel per
  minute, with 5-second buckets in JSON, to stay inside the 10k writes/day free budget.
- **Clip storage** — Cloudflare R2, served through the Worker with HTTP Range support.
- **Collector** — persistent Twitch IRC connection, adaptive spike detector.
- **Renderer** — ffmpeg: VOD seek, frame/audio sampling, 1080×1920 H.264, ASS subtitles.
- **AI (optional)** — Cloudflare Workers AI for vision, Whisper and captions; a local
  heuristic scorer is always available as the fallback.

## Live vs VOD

Clips are cut **while the stream is live**: the collector keeps a rolling ~3 minute HLS
buffer on the runner's temp disk and renders the moment in-process seconds after the
detector fires. If the buffer has no coverage, the scheduled renderer falls back to the
broadcaster's **archive VOD** (which also covers streams that already ended).

The one gap: a collector run lasts 5h45m and starts every 6 hours, so ~15 minutes per
rotation is unrecorded. An always-on free VM removes it; the agent is built to run there
unchanged. Live capture records the public HLS a viewer receives — only point it at
channels you own or have permission to clip.

## What works today

Verified:

- Spike detection, with 7 unit tests (`npm test`).
- Chat ingestion, minute aggregation, spike-to-clip dedupe, mid-run reconciliation.
- Live ring buffer: segment selection, concat and vertical render proven offline —
  1080×1920 H.264 with audio preserved.
- Auth gate, 401s on machine endpoints, schema, storage and quota accounting.

Not yet verified, because it needs live Twitch credentials:

- An end-to-end clip from a real live stream (HLS playback-token path, TS concat
  timings, real caption quality).
- The Workers AI path with a real account.

The app is honest about this in the UI: anything running on the heuristic scorer is
labelled as such rather than presented as model output.

## Repo layout

```
app/                 Next.js pages + API routes
components/          UI (no component library, plain CSS design system)
lib/                 spike engine, Twitch client, AI providers, D1/R2 access, auth guard
db/schema.sql        D1 schema (generated into lib/schema.ts by scripts/gen-schema.mjs)
agent/               cloud worker: collector + ffmpeg renderer
.github/workflows/   scheduled collector and renderer jobs
```

## Local development (optional)

The product does not need your machine. Only use this if you want to change it.

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # spike detector tests
cd agent && npm install && npm run build
```

Hosted secrets and agent variables are documented in [.env.example](.env.example) and
[SETUP.md](SETUP.md).

## Running costs

Every component fits a free tier: Freebuff Sites (Workers + D1 + R2), GitHub Actions on
a public repository, and optional Cloudflare Workers AI neurons. There is no paid API,
no credit card and no automatic upgrade path. Exact ceilings and what happens when one
is reached are in [ARCHITECTURE.md](ARCHITECTURE.md).
