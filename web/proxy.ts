import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { sessionCookieName } from "./lib/auth/config";
import { verifySession } from "./lib/auth/session";

/**
 * Auth proxy (Next 16 renamed middleware → proxy).
 *
 * Guards PAGE visits: an unauthenticated visitor to any portal page is
 * redirected to /login (carrying the requested path in ?next= so login can
 * return them there). /login and static assets always pass through, and API
 * routes are NOT patrolled here — they enforce auth per-route via the
 * `withAuth` guard in lib/auth/guard.
 *
 * NOTE: session cookies are signed with the SESSION_SECRET env var. That secret
 * must be set consistently so the proxy and the route handlers (which may run
 * in a separate runtime context) verify the same signature. Without it, an
 * ephemeral per-process key is used and the login → redirect pairing breaks
 * across process boundaries — so set SESSION_SECRET in any real deployment.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/login") {
    return NextResponse.next();
  }

  const token = request.cookies.get(sessionCookieName())?.value;
  const session = token ? await verifySession(token) : null;
  if (session) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // All page routes except /login, API routes and static assets. API auth is
  // enforced per-route by `withAuth`; the proxy only handles page redirects.
  // The perses plugin bundles under /perses-viewer are static and must load
  // for authenticated dashboards, so they pass through too.
  matcher: [
    "/((?!api|login|perses-viewer|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|ico|woff2?)$).*)",
  ],
};