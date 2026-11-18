import { freebuffAuth } from "./freebuff";
import type { FreebuffUser } from "@freebuff/auth";

/**
 * Authorization boundary for browser-facing routes. Machine endpoints use
 * INGEST_TOKEN instead and never call this.
 */
export async function currentUser(): Promise<FreebuffUser | null> {
  try {
    return await freebuffAuth().getUser();
  } catch {
    return null;
  }
}

/** Returns a 401 response when the caller is not signed in, otherwise null. */
export async function denied(): Promise<Response | null> {
  const user = await currentUser();
  if (user) return null;
  return new Response(JSON.stringify({ error: "Sign in required" }), {
    status: 401,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
