import { createFreebuffNext } from "@freebuff/auth/next";

type Auth = ReturnType<typeof createFreebuffNext>;

let instance: Auth | null = null;

/**
 * Sign in with Freebuff. FREEBUFF_CLIENT_ID and APP_ORIGIN are public
 * configuration injected by the deployment, not secrets. There is no client
 * secret and no session secret to manage.
 *
 * Constructed lazily: the SDK validates the origin immediately, and at build
 * time (before the deployment injects APP_ORIGIN) there is no origin to
 * validate. Routes that need auth run on demand, so this is created on first
 * request instead.
 */
export function freebuffAuth(): Auth {
  if (instance) return instance;
  const baseUrl = process.env.APP_ORIGIN ?? "http://localhost:3000";
  instance = createFreebuffNext({
    clientId: process.env.FREEBUFF_CLIENT_ID ?? "unconfigured",
    baseUrl,
    allowInsecureLocalhost: baseUrl.startsWith("http://localhost") || baseUrl.startsWith("http://127.0.0.1"),
  });
  return instance;
}
