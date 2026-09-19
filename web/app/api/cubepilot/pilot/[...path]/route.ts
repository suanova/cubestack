// /api/cubepilot/pilot/<api/v1/...> — passthrough to the CubePilot agent API
// (the cubepilot-api service; base resolution in lib/cubepilot/pilotapi.ts).
// The chat SSE stream, session list/history, and the HITL approval/question
// channels have no CRD form (docs/cubepilot/api.md §1 "Path A"), so they are
// proxied verbatim with the caller's identity injected as X-CubePilot-User.
// A strict allow-list covers exactly the client-facing chat + session
// endpoints; anything else is a 404.

import { pilotFetch, resolvePilotBase } from "@/lib/cubepilot/pilotapi";
import { upstreamPath } from "@/lib/cubepilot/pilotpath";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };


async function proxy(req: Request, user: string, path: string): Promise<Response> {
  const base = resolvePilotBase();
  if (!base) {
    return Response.json(
      { error: "CubePilot agent API not found: set CUBESTACK_PILOT_URL (or run the portal in-cluster)" },
      { status: 503 },
    );
  }
  let upstream: Response;
  try {
    upstream = await pilotFetch(path, user, {
      method: req.method,
      body: req.method === "POST" ? await req.text() : undefined,
      signal: (req as { signal?: AbortSignal }).signal,
    });
  } catch (e) {
    return Response.json({ error: `agent API unreachable: ${String(e)}` }, { status: 502 });
  }
  // SSE (the chat turn) passes straight through; everything else is a small
  // JSON document, forwarded with its status and body intact.
  if ((upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
    });
  }
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

export const GET = withAuth<Ctx>(async (req, session, ctx) => {
  const path = upstreamPath("GET", (await ctx.params).path);
  if (!path) return Response.json({ error: "not found" }, { status: 404 });
  return proxy(req, session.user, path);
});

export const POST = withAuth<Ctx>(async (req, session, ctx) => {
  const path = upstreamPath("POST", (await ctx.params).path);
  if (!path) return Response.json({ error: "not found" }, { status: 404 });
  return proxy(req, session.user, path);
});

export const DELETE = withAuth<Ctx>(async (req, session, ctx) => {
  const path = upstreamPath("DELETE", (await ctx.params).path);
  if (!path) return Response.json({ error: "not found" }, { status: 404 });
  return proxy(req, session.user, path);
});
