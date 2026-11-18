import { env } from "./db";

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export const bad = (message: string, status = 400) => json({ error: message }, status);

/** Bearer-token check for machine-to-machine endpoints (collector, renderer). */
export async function isIngestAuthorized(req: Request): Promise<boolean> {
  const e = await env();
  if (!e.INGEST_TOKEN) {
    // No token configured: allow so a fresh deployment can bootstrap, but the
    // health endpoint reports this as a security warning.
    return true;
  }
  const header = req.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (token.length !== e.INGEST_TOKEN.length) return false;
  // constant-time-ish compare
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ e.INGEST_TOKEN.charCodeAt(i);
  return diff === 0;
}

export function badRequestForLogin(login: unknown): string | null {
  if (typeof login !== "string") return "login must be a string";
  if (!/^[a-z0-9_]{3,25}$/i.test(login)) return "invalid Twitch login";
  return null;
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
