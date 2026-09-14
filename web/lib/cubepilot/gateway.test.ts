// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { gatewayFetch, gatewayTokenHeader, resolveGatewayBase } from "./gateway";

// The discovery path (no CUBESTACK_GATEWAT_URL) talks to the real cluster and
// is intentionally not covered here — it is exercised by the e2e probes.

describe("lib/cubepilot/gateway", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("resolveGatewayBase prefers CUBESTACK_GATEWAT_URL and strips trailing slashes", async () => {
    vi.stubEnv("CUBESTACK_GATEWAT_URL", "http://gw.test:8080/");
    const base = await resolveGatewayBase();
    expect(base).toEqual({ url: "http://gw.test:8080", via: "direct" });
  });

  it("gatewayFetch calls the direct URL and applies the token header", async () => {
    vi.stubEnv("CUBESTACK_GATEWAT_URL", "http://gw.test:8080");
    vi.stubEnv("CUBESTACK_GATEWAY_TOKEN", "tok-123");
    const seen: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.url = url;
        seen.headers = init?.headers;
        return new Response("{}", { status: 200 });
      }),
    );
    const res = await gatewayFetch("/v1/models");
    expect(res.status).toBe(200);
    expect(seen.url).toBe("http://gw.test:8080/v1/models");
    expect(seen.headers).toEqual({ Authorization: "Bearer tok-123" });
  });

  it("gatewayTokenHeader is empty without a token", () => {
    expect(gatewayTokenHeader()).toEqual({});
  });
});
