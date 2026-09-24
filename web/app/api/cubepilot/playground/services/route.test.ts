// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { authedGet, bareGet } from "@/test/auth";

// Off-cluster with nothing to discover: the gateway module's Service lookup must
// not reach for a real kubeconfig in a unit test.
vi.mock("@/lib/kubernetes", () => ({
  getCoreClient: () => {
    throw new Error("no cluster in this test");
  },
  getKubeConfig: () => ({ getCurrentCluster: () => null }),
}));

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

  it("returns 502 without the upstream detail when /v1/models fails", async () => {
    vi.stubEnv("CUBESTACK_GATEWAT_URL", "http://gw.test:8080");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 404 })));
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(502);
    // A fixed phrase, not the upstream body or the status: nothing downstream
    // shows it, and an internal detail is not this route's to hand out.
    expect(await res.json()).toEqual({ models: [], endpoint: null, error: "model catalog unavailable" });
  });

  it("returns 502 without the transport error when the gateway is unreachable", async () => {
    // The shape a cluster with no platform model service produces: Node's fetch
    // rejects with "TypeError: fetch failed" (cause ENOTFOUND), and that string
    // used to travel all the way into the page.
    vi.stubEnv("CUBESTACK_GATEWAT_URL", "http://gw.test:8080");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ models: [], endpoint: null, error: "model catalog unavailable" });
  });

  it("returns 503 with the same fixed phrase when no gateway is resolvable", async () => {
    // No env override and no discoverable Service: the body must not repeat the
    // resolution hint (an env var name, a namespace) either.
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ models: [], endpoint: null, error: "model catalog unavailable" });
  });
});
