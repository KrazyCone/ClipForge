import { db, env } from "./db";

/**
 * Re-cuts used to wait for the renderer's scheduled run, which only wakes every
 * ten minutes. Asking GitHub to start one the moment a clip is queued turns
 * that wait into the length of the render itself.
 *
 * Two guards keep this cheap: at most one dispatch per `DISPATCH_WINDOW_SEC`
 * (a burst of re-cuts rides the same run), and with no token configured this
 * is a no-op, so the scheduled run still picks the work up. A dispatch failure
 * never fails the request.
 */
const DISPATCH_WINDOW_SEC = 90;

async function claimDispatch(): Promise<boolean> {
  const d = await db();
  const now = Math.floor(Date.now() / 1000);
  const row = await d
    .prepare("SELECT value FROM settings WHERE key = 'renderer_dispatch_at'")
    .first<{ value: string }>();
  if (now - (Number(row?.value) || 0) < DISPATCH_WINDOW_SEC) return false;
  await d
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('renderer_dispatch_at', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(String(now))
    .run();
  return true;
}

export async function nudgeRenderer(reason: string): Promise<boolean> {
  try {
    const e = await env();
    const token = e.GITHUB_DISPATCH_TOKEN;
    if (!token) return false;
    if (!(await claimDispatch())) return false;

    const repository = e.GITHUB_REPOSITORY || "KrazyCone/ClipForge";
    const ref = e.GITHUB_DISPATCH_REF || "main";
    const res = await fetch(
      `https://api.github.com/repos/${repository}/actions/workflows/render.yml/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "clipforge",
        },
        body: JSON.stringify({ ref }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      console.warn(
        `renderer dispatch (${reason}) failed: ${res.status} ${(await res.text()).slice(0, 160)}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      `renderer dispatch (${reason}) skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
