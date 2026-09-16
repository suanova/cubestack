// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { authedGet, bareGet } from "@/test/auth";

const { GET } = await import("./route");

describe("/api/cubepilot/playground/services", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), undefined)).status).toBe(401);
  });

  it("lists the gateway models and the endpoint", async () => {
    vi.stubEnv("CUBESTACK_GATEWAT_URL", "http://gw.test:8080");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("http://gw.test:8080/v1/models");
        return new Response(JSON.stringify({ object: "list", data: [{ id: "qwen38-27b-fp16", owned_by: "cubestack" }, { id: "dsv4" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ id: string; ownedBy: string }>; endpoint: string | null };
    expect(body.models).toEqual([
      { id: "qwen38-27b-fp16", ownedBy: "cubestack" },
      { id: "dsv4", ownedBy: "" },
    ]);
    expect(body.endpoint).toBe("http://gw.test:8080");
  });

  it("returns 502 with the gateway error when /v1/models fails", async () => {
    vi.stubEnv("CUBESTACK_GATEWAT_URL", "http://gw.test:8080");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 404 })));
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("404");
  });
});
