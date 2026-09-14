// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { authedGet, bareGet } from "@/test/auth";

const { GET } = await import("./route");

describe("/api/cubepilot/agent/status", () => {
  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), undefined)).status).toBe(401);
  });

  it("returns the caller's instance status", async () => {
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      exists: boolean;
      id: string;
      phase: string;
      user: string;
      uptimeSeconds: number;
      gatewayImage: string;
    };
    expect(body.exists).toBe(true);
    expect(body.id).toBe("agent-tester");
    expect(body.user).toBe("tester");
    expect(body.phase).toBe("Ready");
    expect(body.uptimeSeconds).toBeGreaterThan(0);
    expect(body.gatewayImage).toBe("cubestack/cubepilot-gateway:v1.4.0");
  });
});
