// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { authedGet, authedRequest, bareGet } from "@/test/auth";

const { GET, POST } = await import("./route");

describe("/api/cubepilot/sessions", () => {
  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), undefined)).status).toBe(401);
    expect((await POST(await bareGet(), undefined)).status).toBe(401);
  });

  it("lists the seeded sessions", async () => {
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ sessionKey: string; title: string }> };
    expect(body.sessions.map((s) => s.sessionKey)).toEqual([
      "agent:main-gpu-temp-0826",
      "agent:main-cluster-0825",
      "agent:main-isvc-0824",
    ]);
    expect(body.sessions[0].title).toBe("GPU 温度告警排查");
  });

  it("creates a session", async () => {
    const res = await POST(await authedRequest({ method: "POST" }), undefined);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sessionKey: string };
    expect(body.sessionKey).toMatch(/^agent:main-s-/);
  });
});
