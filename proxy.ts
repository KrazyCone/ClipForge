import { NextResponse, type NextRequest } from "next/server";
import { freebuffAuth } from "./lib/freebuff";

/**
 * Refreshes an expired session before the page renders, and passes the
 * refreshed cookie to both the render and the browser.
 */
export async function proxy(request: NextRequest) {
  try {
    return await freebuffAuth().proxy(request);
  } catch {
    // Never let a session-refresh hiccup take the whole site down; the
    // per-route getUser() checks are the real authorization boundary.
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
