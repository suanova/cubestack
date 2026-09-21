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

  it("proxies a send to the conversation's own path, with the caller identity", async () => {
    const res = await POST(
      await authedRequest({ method: "POST", body: '{"content":"hi"}' }),
      ctx(["api", "v1", "sessions", ...key, "messages"]),
    );
    expect(res.status).toBe(200);
    expect(pilotFetch).toHaveBeenCalledWith(
      `/api/v1/sessions/${key.join("/")}/messages`,
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
    [["turn"], "GET"],
    [["approvals"], "GET"],
    [["questions"], "GET"],
    [["approvals", "decision"], "POST"],
    [["questions", "answer"], "POST"],
    [["questions", "cancel"], "POST"],
    [["abort"], "POST"],
  ] as const)("proxies %s (%s)", async (tail, method) => {
    const req = method === "GET" ? await authedGet() : await authedRequest({ method: "POST", body: "{}" });
    const fn = method === "GET" ? GET : POST;
    const res = await fn(req, ctx(["api", "v1", "sessions", ...key, ...tail]));
    expect(res.status).toBe(200);
    expect(pilotFetch).toHaveBeenCalledWith(
      `/api/v1/sessions/${key.join("/")}/${tail.join("/")}`,
      "tester",
      expect.anything(),
    );
  });

  it("proxies the collections a reload restores cards from", async () => {
    await GET(await authedGet(), ctx(["api", "v1", "sessions", ...key, "approvals"]));
    expect(pilotFetch).toHaveBeenCalledWith(`/api/v1/sessions/${key.join("/")}/approvals`, "tester", expect.anything());
    await GET(await authedGet(), ctx(["api", "v1", "sessions", ...key, "questions"]));
    expect(pilotFetch).toHaveBeenCalledWith(`/api/v1/sessions/${key.join("/")}/questions`, "tester", expect.anything());
  });

  it("proxies a collection for single-segment session keys", async () => {
    await GET(await authedGet(), ctx(["api", "v1", "sessions", "agent:main:conv-1", "approvals"]));
    expect(pilotFetch).toHaveBeenCalledWith("/api/v1/sessions/agent%3Amain%3Aconv-1/approvals", "tester", expect.anything());
  });

  it("404s anything outside the allow-list", async () => {
    const cases: Array<[NextRequest, string[]]> = [
      [await authedGet(), ["api", "v1", "messages"]], // the send route without a conversation
      [await authedRequest({ method: "POST", body: "{}" }), ["api", "v1", "messages"]], // the superseded send route
      [await authedRequest({ method: "POST", body: "{}" }), ["api", "v1", "sessions"]], // POST on a GET-only shape
      [await authedGet(), ["api", "v1", "instances"]], // not client-facing
      [await authedGet(), ["api", "v2", "sessions"]], // wrong api version
      [await authedGet(), ["api", "v1", "sessions", ...key, "delete"]], // unknown tail
      [await authedGet(), ["api", "v1", "sessions", ...key, "approvals", "decision"]], // action asked for with GET
      [await authedGet(), ["api", "v1", "sessions", ...key, "approvals", "pending"]], // the superseded two-segment tail
      [await authedGet(), ["api", "v1", "sessions", ...key, "turn", "events"]], // a route the portal does not use
      [await authedGet(), ["api", "v1", "sessions", ...key, "approvals", "decision", "extra"]], // too deep
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
    const cases: Array<[string, string[]]> = [
      ["GET", ["api", "v1", "sessions", "..", "..", "admin", "messages"]],
      ["POST", ["api", "v1", "sessions", "..", "approvals", "decision"]],
      ["GET", ["api", "v1", "sessions", ".", "messages"]],
      ["GET", ["api", "v1", "sessions", "..", "turn"]],
    ];
    for (const [method, path] of cases) {
      const req = method === "GET" ? await authedGet() : await authedRequest({ method: "POST", body: "{}" });
      const fn = method === "GET" ? GET : POST;
      const res = await fn(req, ctx(path));
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
    // The failure shape a caller has to tell apart from an empty collection:
    // "the gateway could not be asked" is a 502, and it is not "nothing is
    // pending".
    pilotFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "gateway unavailable" }), { status: 502, headers: { "content-type": "application/json" } }),
    );
    const res = await GET(await authedGet(), ctx(["api", "v1", "sessions", ...key, "approvals"]));
    expect(res.status).toBe(502);
    expect((await res.json()) as object).toEqual({ error: "gateway unavailable" });
  });

  it("passes the SSE stream through unbuffered", async () => {
    const payload = ": ping\ndata: {\"type\":\"message_start\",\"sessionId\":\"s1\"}\n\ndata: {\"type\":\"message_done\",\"sessionId\":\"s1\"}\n\n";
    pilotFetch.mockResolvedValue(new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await POST(
      await authedRequest({ method: "POST", body: '{"content":"hi"}' }),
      ctx(["api", "v1", "sessions", ...key, "messages"]),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(await res.text()).toBe(payload);
  });
});
