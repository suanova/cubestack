// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { authedGet, authedRequest, bareGet } from "@/test/auth";

const { GET, POST } = await import("./route");

const ctx = (key: string) => ({ params: Promise.resolve({ key }) });

describe("/api/cubepilot/sessions/[key]/messages", () => {
  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), ctx("agent:main-gpu-temp-0826"))).status).toBe(401);
    expect((await POST(await bareGet(), ctx("agent:main-gpu-temp-0826"))).status).toBe(401);
  });

  it("returns the seeded history", async () => {
    const res = await GET(await authedGet(), ctx("agent:main-cluster-0825"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ role: string }> };
    expect(body.items).toHaveLength(2);
    expect(body.items.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("404s for an unknown session", async () => {
    const res = await GET(await authedGet(), ctx("agent:main-nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
  });

  it("appends a user message with the simulated reply", async () => {
    const res = await POST(await authedRequest({ method: "POST", body: JSON.stringify({ text: "帮我做一次集群巡检" }) }), ctx("agent:main-gpu-temp-0826"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { reply: { text: string; tools?: unknown[] } };
    expect(body.reply.text).toContain("| 类别 | 结果 |");
    // The message is now part of the history.
    const after = await GET(await authedGet(), ctx("agent:main-gpu-temp-0826"));
    const items = ((await after.json()) as { items: unknown[] }).items;
    expect(items).toHaveLength(4);
  });

  it("400s on empty or invalid bodies", async () => {
    expect(
      (await POST(await authedRequest({ method: "POST", body: JSON.stringify({ text: "  " }) }), ctx("agent:main-gpu-temp-0826"))).status,
    ).toBe(400);
    expect(
      (await POST(await authedRequest({ method: "POST", body: "not-json" }), ctx("agent:main-gpu-temp-0826"))).status,
    ).toBe(400);
  });
});
