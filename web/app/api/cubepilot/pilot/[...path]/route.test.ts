// @vitest-environment node
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedGet, authedRequest, bareGet } from "@/test/auth";

const { resolvePilotBase, pilotFetch } = vi.hoisted(() => ({
  resolvePilotBase: vi.fn(),
  pilotFetch: vi.fn(),
}));

vi.mock("@/lib/cubepilot/pilotapi", () => ({ resolvePilotBase, pilotFetch }));

const { GET, POST } = await import("./route");

const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });

const key = ["agent", "main", "conv-1"];

describe("/api/cubepilot/pilot/[...path]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolvePilotBase.mockReturnValue("http://cubepilot-api.cubestack-system.svc:8080");
    // A fresh Response per call (a single instance's body could only be read once).
    pilotFetch.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), ctx(["api", "v1", "sessions"]))).status).toBe(401);
  });

  it("proxies POST api/v1/messages with the caller identity", async () => {
    const res = await POST(
      await authedRequest({ method: "POST", body: '{"content":"hi"}' }),
      ctx(["api", "v1", "messages"]),
    );
    expect(res.status).toBe(200);
    expect(pilotFetch).toHaveBeenCalledWith(
      "/api/v1/messages",
      "tester",
      expect.objectContaining({ method: "POST", body: '{"content":"hi"}' }),
    );
  });

  it("proxies GET api/v1/sessions", async () => {
    await GET(await authedGet(), ctx(["api", "v1", "sessions"]));
    expect(pilotFetch).toHaveBeenCalledWith("/api/v1/sessions", "tester", expect.objectContaining({ method: "GET" }));
  });

  it("keeps multi-segment session keys and re-encodes them", async () => {
    await GET(await authedGet(), ctx(["api", "v1", "sessions", ...key, "messages"]));
    expect(pilotFetch).toHaveBeenCalledWith(`/api/v1/sessions/${key.join("/")}/messages`, "tester", expect.anything());
  });

  it.each([
    ["turn", "GET"],
    ["approval", "POST"],
    ["question", "POST"],
    ["abort", "POST"],
  ] as const)("proxies %s (%s)", async (tail, method) => {
    const req = method === "GET" ? await authedGet() : await authedRequest({ method: "POST", body: "{}" });
    const fn = method === "GET" ? GET : POST;
    const res = await fn(req, ctx(["api", "v1", "sessions", ...key, tail]));
    expect(res.status).toBe(200);
    expect(pilotFetch).toHaveBeenCalledWith(`/api/v1/sessions/${key.join("/")}/${tail}`, "tester", expect.anything());
  });

  it("proxies the pending-approval and pending-question GETs", async () => {
    await GET(await authedGet(), ctx(["api", "v1", "sessions", ...key, "approval", "pending"]));
    expect(pilotFetch).toHaveBeenCalledWith(`/api/v1/sessions/${key.join("/")}/approval/pending`, "tester", expect.anything());
    await GET(await authedGet(), ctx(["api", "v1", "sessions", ...key, "question", "pending"]));
    expect(pilotFetch).toHaveBeenCalledWith(`/api/v1/sessions/${key.join("/")}/question/pending`, "tester", expect.anything());
  });

  it("proxies pending GETs for single-segment session keys", async () => {
    await GET(await authedGet(), ctx(["api", "v1", "sessions", "agent:main:conv-1", "approval", "pending"]));
    expect(pilotFetch).toHaveBeenCalledWith("/api/v1/sessions/agent%3Amain%3Aconv-1/approval/pending", "tester", expect.anything());
  });

  it("404s anything outside the allow-list", async () => {
    const cases: Array<[NextRequest, string[]]> = [
      [await authedGet(), ["api", "v1", "messages"]], // GET on a POST-only shape
      [await authedRequest({ method: "POST", body: "{}" }), ["api", "v1", "sessions"]], // POST on a GET-only shape
      [await authedGet(), ["api", "v1", "instances"]], // not client-facing
      [await authedGet(), ["api", "v2", "sessions"]], // wrong api version
      [await authedGet(), ["api", "v1", "sessions", ...key, "delete"]], // unknown tail
      [await authedGet(), ["api", "v1", "sessions", ...key, "approval", "pending", "extra"]], // too deep
    ];
    for (const [req, path] of cases) {
      const fn = req.method === "GET" ? GET : POST;
      const res = await fn(req, ctx(path));
      expect(res.status).toBe(404);
    }
    expect(pilotFetch).not.toHaveBeenCalled();
  });

  it("404s a session key that would escape the sessions prefix", async () => {
    // Next.js decodes the segment before the handler runs, so %2E%2E arrives
    // as ".." and encodeURIComponent would leave it intact.
    const cases: string[][] = [
      ["api", "v1", "sessions", "..", "..", "admin", "messages"],
      ["api", "v1", "sessions", "..", "approval", "pending"],
      ["api", "v1", "sessions", ".", "messages"],
      ["api", "v1", "sessions", "..", "turn"],
    ];
    for (const path of cases) {
      const res = await GET(await authedGet(), ctx(path));
      expect(res.status).toBe(404);
    }
    expect(pilotFetch).not.toHaveBeenCalled();
  });

  it("503s when the agent API base cannot be resolved", async () => {
    resolvePilotBase.mockReturnValue(null);
    const res = await GET(await authedGet(), ctx(["api", "v1", "sessions"]));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("CUBESTACK_PILOT_URL");
    expect(pilotFetch).not.toHaveBeenCalled();
  });

  it("502s when the upstream fetch fails", async () => {
    pilotFetch.mockRejectedValue(new Error("fetch failed"));
    const res = await GET(await authedGet(), ctx(["api", "v1", "sessions"]));
    expect(res.status).toBe(502);
  });

  it("forwards non-SSE responses with status and body intact", async () => {
    pilotFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "no pending approval" }), { status: 404, headers: { "content-type": "application/json" } }),
    );
    const res = await GET(await authedGet(), ctx(["api", "v1", "sessions", ...key, "approval", "pending"]));
    expect(res.status).toBe(404);
    expect((await res.json()) as object).toEqual({ error: "no pending approval" });
  });

  it("passes the SSE stream through unbuffered", async () => {
    const payload = ": ping\ndata: {\"type\":\"message_start\",\"sessionId\":\"s1\"}\n\ndata: {\"type\":\"message_done\",\"sessionId\":\"s1\"}\n\n";
    pilotFetch.mockResolvedValue(new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await POST(await authedRequest({ method: "POST", body: '{"content":"hi"}' }), ctx(["api", "v1", "messages"]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(await res.text()).toBe(payload);
  });
});
