import type { NextRequest } from "next/server";

import { logger } from "@/lib/log";

import { sessionCookieName } from "./config";
import { verifySession, type SessionClaims } from "./session";

// Shared auth guard for API route handlers.
//
// Apply it to every route under `app/api/**` EXCEPT the auth routes
// (`/api/auth/login`, `/api/auth/logout`, `/api/auth/me`). A request without a
// valid session cookie gets a 401 before the handler runs, so no Kubernetes
// client is ever built for an unauthenticated caller.
//
// The wrapped handler receives the verified session; dynamic-route context
// (e.g. `{ params }`) is passed through as the third argument:
//
//   export const GET = withAuth(async (_req, session) => {
//     return Response.json(await loadDashboard(session.user));
//   });
//
//   export const GET = withAuth(async (req, _session, ctx) => {
//     const { path } = await ctx.params;
//     ...
//   });
//
// It is the single convention for protected routes: a future route forgets the
// guard only by not wrapping its exports in `withAuth` (the pattern is
// enforced by each route's own tests).
export function withAuth<Ctx = unknown>(
  handler: (req: NextRequest, session: SessionClaims, ctx: Ctx) => Promise<Response>,
): (req: NextRequest, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    const started = Date.now();
    const token = req.cookies.get(sessionCookieName())?.value;
    const session = token ? await verifySession(token) : null;
    if (!session) {
      logger("api").info("request", { method: req.method, path: new URL(req.url).pathname, status: 401, ms: Date.now() - started });
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
      const res = await handler(req, session, ctx);
      const fields = { method: req.method, path: new URL(req.url).pathname, user: session.user, status: res.status, ms: Date.now() - started };
      // A failing request is worth a warning: those are the lines a deployment
      // with default (info) logging still shows.
      if (res.status >= 500) logger("api").warn("request failed", fields);
      else logger("api").info("request", fields);
      return res;
    } catch (e) {
      logger("api").error("request threw", { method: req.method, path: new URL(req.url).pathname, user: session.user, ms: Date.now() - started, error: e });
      throw e;
    }
  };
}