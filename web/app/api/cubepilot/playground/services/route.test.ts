// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { authedGet, bareGet } from "@/test/auth";

const { GET } = await import("./route");

describe("/api/cubepilot/playground/services", () => {
  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), undefined)).status).toBe(401);
  });

  it("lists the running services and the scaling note", async () => {
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      services: Array<{ serviceId: string; qps: number; p95Ms: number; persona: string }>;
      scaling: Array<{ name: string; engine: string }>;
    };
    expect(body.services.map((s) => s.serviceId)).toEqual(["glm-5.2-chat", "deepseek-v4", "llama3-8b-chat"]);
    expect(body.services[0].qps).toBe(42);
    expect(body.scaling).toEqual([{ name: "qwen2.5-72b", engine: "GPUStack" }]);
  });
});
