// /api/cubepilot/pilot/<api/v1/...> — passthrough to the CubePilot agent API
// (the cubepilot-api service; base resolution in lib/cubepilot/pilotapi.ts).
// The chat SSE stream, session list/history, and the HITL approval/question
// channels have no CRD form (docs/cubepilot/api.md §1 "Path A"), so they are
// proxied verbatim with the caller's identity injected as X-CubePilot-User.
// A strict allow-list covers exactly the client-facing chat + session
// endpoints; anything else is a 404.

import { pilotFetch, resolvePilotBase } from "@/lib/cubepilot/pilotapi";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

/**
 * Encode a session key (its "/"-separated segments) into one upstream path, or
 * null when it cannot be encoded. encodeURIComponent leaves "." and ".."
 * untouched, so a decoded request carrying %2e%2e would join into a path the
 * URL parser resolves away, escaping the /api/v1/sessions prefix.
 */
const enc = (segments: string[]): string | null => {
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return segments.map(encodeURIComponent).join("/");
};

/**
 * Maps an allowed request to its upstream path, or null when the shape is not
 * one of the client-facing chat/session endpoints. A session key may contain
 * slashes (the API matches session sub-resources by suffix), so the key is
 * everything between "sessions" and the tail segment.
 */
function upstreamPath(method: string, segments: string[]): string | null {
  if (segments[0] !== "api" || segments[1] !== "v1") return null;
  const rest = segments.slice(2);
  if (rest.length === 1 && rest[0] === "messages" && method === "POST") return "/api/v1/messages";
  if (rest.length === 1 && rest[0] === "sessions" && method === "GET") return "/api/v1/sessions";
  if (rest.length < 3 || rest[0] !== "sessions") return null;
  const tail = rest[rest.length - 1];
  if (tail === "pending") {
    const action = rest[rest.length - 2];
    // sessions/<key…>/<approval|question>/pending — the key is ≥1 segment.
    if ((action === "approval" || action === "question") && method === "GET" && rest.length >= 4) {
      const key = enc(rest.slice(1, -2));
      return key === null ? null : `/api/v1/sessions/${key}/${action}/pending`;
    }
    return null;
  }
  const tailMethod: Record<string, string> = {
    messages: "GET",
    abort: "POST",
    turn: "GET",
    approval: "POST",
    question: "POST",
  };
  if (tailMethod[tail] === method) {
    const key = enc(rest.slice(1, -1));
    return key === null ? null : `/api/v1/sessions/${key}/${tail}`;
  }
  return null;
}

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
