/**
 * Clip renderer. Pulls queued work from the ClipForge API and renders it from
 * the broadcaster's archive VOD. The collector drains the same queue between
 * chat bursts, so this job is the fast path when something is waiting.
 */
import { loadConfig, log } from "./config.js";
import { ClipforgeApi } from "./api.js";
import { TwitchVod } from "./twitch.js";
import { describeDrain, drainQueue } from "./render.js";

async function main() {
  const cfg = loadConfig();
  const api = new ClipforgeApi(cfg);
  const vod = new TwitchVod();

  let result;
  try {
    result = await drainQueue({ api, vod, limit: 4 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("renderer failed", message);
    await api.recordRun("renderer", "failed", message.slice(0, 300));
    process.exitCode = 1;
    return;
  }

  if (!result.hadWork) {
    log("queue empty");
    await api.recordRun("renderer", "idle", "queue empty");
    return;
  }

  const detail = describeDrain(result);
  log(detail);
  await api.recordRun("renderer", result.errors.length ? "partial" : "ok", detail);
  if (result.errors.length && result.rendered === 0 && result.analyzed === 0) process.exitCode = 1;
}

void main().catch((err) => {
  log("renderer crashed", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
