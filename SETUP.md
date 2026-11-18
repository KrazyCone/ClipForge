# Setup

From nothing to your first clip. No software is installed on your computer — every step
is a website.

**Current state:** the site is deployed and published; `TWITCH_CLIENT_ID`,
`TWITCH_CLIENT_SECRET`, `INGEST_TOKEN`, `CF_ACCOUNT_ID` and `CF_AI_TOKEN` are all set, and
`/api/health` reports `twitch: true`, `ai: true`, `ingestToken: true` with no warnings.
The repository is public. What remains: steps 4, 5, 6, 7, and the one-click Meta licence
in 8c.

---

## Checklist

| # | Step | Where | Done |
|---|---|---|---|
| 0 | Twitch application created | dev.twitch.tv | ✅ |
| 1 | Twitch Client ID + Secret added | Sites → Secrets | ✅ |
| 2 | Redeploy so the secrets take effect | Sites | ✅ |
| 3 | `INGEST_TOKEN` added | Sites → Secrets | ✅ |
| 4 | Code pushed to GitHub | GitHub | ⬜ |
| 5 | Two Actions secrets added | GitHub → Settings | ⬜ |
| 6 | Channel added | ClipForge → Channels | ⬜ |
| 7 | Collector run manually once | GitHub → Actions | ⬜ |
| 8 | Workers AI keys ✅ / Meta vision licence | /settings | ⬜ |

---

## Step 2 — Redeploy

Sites bakes environment values into each deployment, so the Twitch keys you added are
not live until the app is rebuilt.

**https://vyral-stzd3l-preview.freebuff.page/api/health** should show:

```json
"config": { "twitch": true, "ingestToken": false }
```

If `twitch` is still `false`, the deploy hasn't happened yet. (`ingestToken: false` is
expected until step 3.)

---

## Step 3 — `INGEST_TOKEN`

The collector and renderer are machines, not browsers, so they can't use your Freebuff
session. They authenticate with this shared secret instead. Without it those endpoints
accept anyone who knows the URL.

Generate one (any terminal you already have — this is not software to install):

```bash
openssl rand -hex 32
```

If you don't have `openssl`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add it in the **Sites** panel → ClipForge → **Secrets** as `INGEST_TOKEN`, then redeploy
again. Keep the value — step 5 needs the identical string.

---

## Step 4 — Push the code to GitHub

**Still outstanding.** The application lives in a workspace and has not been committed
to **https://github.com/KrazyCone/ClipForge** yet. The repository currently holds only
its initial commit, so GitHub Actions has nothing to run.

Ask for the code to be committed and pushed to `main`.

---

## Step 5 — GitHub Actions secrets

**https://github.com/KrazyCone/ClipForge/settings/secrets/actions** → **New repository
secret**, twice:

| Name | Value |
|---|---|
| `CLIPFORGE_BASE_URL` | `https://vyral-stzd3l-preview.freebuff.page` |
| `INGEST_TOKEN` | the exact string from step 3 |

That is all. The collector and renderer no longer need Twitch credentials: they fetch
archive VODs from the site through `GET /api/twitch/videos`, authenticated with
`INGEST_TOKEN`, and the site already holds the client ID and secret. Adding
`TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` here is optional and only saves one hop.

This is deliberate. Sites secrets are write-only and Twitch shows a client secret exactly
once, so copying those values into a second place is a trap. Credentials live in one
system.

`CLIPFORGE_BASE_URL` was renamed from `VYRAL_BASE_URL` — if you added it earlier under
the old name, delete that one.

If the two `INGEST_TOKEN` values differ, the collector gets 401s and the dashboard stays
empty.

### Repo visibility

Already **public** ✅ — which is what this needs: the collector runs ~345 minutes per
run, 4 runs a day (~1,380 minutes/day), and private repos only get 2,000 Actions minutes
**per month**, roughly a day and a half. Actions secrets stay encrypted either way.

If you ever move it back to private, edit `.github/workflows/collect.yml`: set `RUN_SECONDS: "300"`
and the schedule to `*/30 * * * *`. That covers 25 minutes of every half hour instead of
near-continuously.

---

## Step 6 — Add a channel

**https://vyral-stzd3l-preview.freebuff.page/channels**

Type a Twitch login (e.g. `shroud`) and click **Add**, or **Discover live** to pick
something that's streaming now.

**On the "0/3 slots" counter:** the `0` is how many channels you've added, the `3` is a
cap. Change it at **/settings** → **Maximum simultaneous channels** (up to 50).

Three is the default because of the database budget: the free D1 tier allows **10,000 row
writes/day**, and one live channel costs about **1,730/day** (1,440 chat-minute rows +
288 live-status refreshes). **Five channels ≈ 8,600**, which is the practical ceiling.
The Resources panel shows real usage against it.

The Add button stays disabled until step 2 is done — ClipForge has to look the channel up
through the Twitch API to get its ID and live status.

---

## Step 7 — First run

**https://github.com/KrazyCone/ClipForge/actions** → **ClipForge collector** in the left
sidebar → **Run workflow**.

Expected, per live channel:

```
irc connected
live buffer started for <channel> (180s window)
joined #<channel>
```

And when chat breaks pattern:

```
spike <channel> intensity=… 2.1/s -> 19/s (new <id>)
live clip <id>: 3.2 MB, 24.0s
```

The clip lands in **/clips** a minute or two later. The **ClipForge renderer (VOD
fallback)** job runs every 10 minutes to catch anything the live path missed.

---

## Step 8 — Optional: Workers AI (vision, transcription, captions)

Everything works without this, with the limitations labelled in the UI. It is free: 10,000
Neurons/day on the Workers Free plan, no card. ClipForge never upgrades the plan and never
bills you — when the allowance runs out it falls back to the local scorer.

### 8a — Get the two values

1. Sign up at **https://dash.cloudflare.com/sign-up** (email + password, no card).
2. In the dashboard sidebar open **Workers AI**.
3. Click **Use REST API** at the top of the page.
4. Copy the **Account ID** shown there → this is `CF_ACCOUNT_ID`.
5. Click **Create a Workers AI API Token**, review the prefilled permissions (token name
   and Workers AI access), then **Create API Token** → **Copy API Token**. This is
   `CF_AI_TOKEN` and it is shown only once.

### 8b — Add them and redeploy

Sites panel → ClipForge → **Secrets** → add `CF_ACCOUNT_ID` and `CF_AI_TOKEN`, then ask
for a redeploy. **/api/health** should then read:

```json
"config": { "ai": true, "aiModel": "@cf/meta/llama-3.1-8b-instruct-fast" }
```

### 8c — Accept Meta's vision licence (one click)

Meta's Llama vision model refuses to answer until its licence is accepted once for your
account. ClipForge will not accept a licence for you, so this is a button: **/settings**
→ **Storage & quotas** → **Vision licence** → **Accept licence**. Success reads
`Accepted for @cf/meta/llama-3.2-11b-vision-instruct`.

Skipping this breaks frame description only — Whisper and the LLM still run. The reason is
written to the spike's `ai_json` as `visionError` instead of failing silently.

### What actually changes

| | Without Workers AI | With it |
|---|---|---|
| Scoring | chat-signal heuristic | LLM judging chat + transcript + frame notes |
| On-screen text | caption card for the first 3 s | spoken words burned in, spread evenly across the clip (not word-accurate — Whisper timings are not used yet) |
| Vision | none — chat only | up to 3 sampled frames described per moment |

Budget: ~10,000 Neurons/day. One moment costs one text call, three vision calls and one
transcription, so expect a few dozen moments per day. Past that the provider falls back and
each clip records `provider: heuristic`, so the dashboard never claims a model saw the
video when it did not.

Without it: real chat-signal scoring and local caption generation, a caption card burned
into the clip instead of speech subtitles, and no frame analysis.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/api/health` shows `twitch: false` | Secrets added but not redeployed |
| Collector fails immediately | `CLIPFORGE_BASE_URL` or `INGEST_TOKEN` missing or wrong |
| Chat graph stays flat | Channel offline, or the collector isn't running (check Actions) |
| Spikes detected, no clips | Quality floor (Settings, default 55) rejected it, or no buffer coverage; the spike row shows `failed`/`skipped` with the reason |
| Machine endpoints return 401 | The two `INGEST_TOKEN` values differ |
| "Twitch is not configured" on Add | Step 2 not done |
