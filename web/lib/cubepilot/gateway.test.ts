// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const { listNamespacedService } = vi.hoisted(() => ({ listNamespacedService: vi.fn() }));

vi.mock("@/lib/kubernetes", () => ({
  getCoreClient: () => ({ listNamespacedService }),
  getKubeConfig: () => ({ getCurrentCluster: () => ({ server: "https://k8s.test" }), getCurrentUser: () => null }),
}));

// The service-proxy path speaks raw TLS through node:https, which the unit
// environment cannot reach.
const { httpsRequest, httpsAgent } = vi.hoisted(() => ({ httpsRequest: vi.fn(), httpsAgent: vi.fn() }));
vi.mock("node:https", () => ({ request: httpsRequest, Agent: httpsAgent }));

import {
  GATEWAY_NAME,
  GATEWAY_NAMESPACE,
  clearGatewayCaches,
  gatewayCatalog,
  gatewayFetch,
  gatewayFetchForModel,
  gatewayTokenHeader,
  resolveGatewayBase,
  resolveGatewayBases,
} from "./gateway";

// The dataplane Service Envoy Gateway generates for a Gateway. Its name ends in
// a random suffix, so callers identify it by the label Envoy Gateway stamps on
// it — never by name.
const DATAPLANE_LABEL = "gateway.envoyproxy.io/owning-gateway-name";
function dataplaneService(over: { name?: string; port?: number; gateway?: string } = {}) {
  const {
    name = "envoy-envoy-gateway-system-cubestack-gateway-27dc8f39",
    port = 8080,
    gateway = "cubestack-gateway",
  } = over;
  return { metadata: { name, labels: { [DATAPLANE_LABEL]: gateway } }, spec: { ports: [{ port }] } };
}

describe("lib/cubepilot/gateway", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    clearGatewayCaches();
  });

  it("resolveGatewayBase prefers CUBESTACK_GATEWAT_URL and strips trailing slashes", async () => {
    vi.stubEnv("CUBESTACK_GATEWAT_URL", "http://gw.test:8080/");
    const base = await resolveGatewayBase();
    expect(base).toEqual({ url: "http://gw.test:8080", via: "direct", configured: true });
    expect(listNamespacedService).not.toHaveBeenCalled();
  });

  it("gatewayFetch calls the direct URL and applies the token header", async () => {
    vi.stubEnv("CUBESTACK_GATEWAT_URL", "https://gw.test:8443");
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
    expect(seen.url).toBe("https://gw.test:8443/v1/models");
    expect(seen.headers).toEqual({ Authorization: "Bearer tok-123" });
  });

  it("refuses to send the token to a configured non-HTTPS base", async () => {
    vi.stubEnv("CUBESTACK_GATEWAT_URL", "http://gw.test:8080");
    vi.stubEnv("CUBESTACK_GATEWAY_TOKEN", "tok-123");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(gatewayFetch("/v1/models")).rejects.toThrow(/CUBESTACK_GATEWAT_URL is not https/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still sends the token over the in-cluster plain-HTTP base", async () => {
    // The chart's documented default: we resolved this URL ourselves, so the
    // token stays on the cluster network and the call is not refused.
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
    vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
    vi.stubEnv("CUBESTACK_GATEWAY_TOKEN", "tok-123");
    listNamespacedService.mockResolvedValue({ items: [dataplaneService()] });
    const seen: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.url = url;
        seen.headers = init?.headers;
        return new Response("{}", { status: 200 });
      }),
    );
    expect((await gatewayFetch("/v1/models")).status).toBe(200);
    expect(seen.url).toBe("http://envoy-envoy-gateway-system-cubestack-gateway-27dc8f39.envoy-gateway-system.svc:8080/v1/models");
    expect(seen.headers).toEqual({ Authorization: "Bearer tok-123" });
  });

  it("gatewayTokenHeader is empty without a token", () => {
    expect(gatewayTokenHeader()).toEqual({});
  });

  it("uses the discovered service when found (in cluster)", async () => {
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
    vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
    listNamespacedService.mockResolvedValue({ items: [dataplaneService()] });
    const base = await resolveGatewayBase();
    expect(base).toEqual({
      name: "cubestack-gateway",
      url: "http://envoy-envoy-gateway-system-cubestack-gateway-27dc8f39.envoy-gateway-system.svc:8080",
      via: "direct",
    });
  });

  // The platform installs two model catalogs, each behind its own Gateway.
  // Their dataplane Services carry the Gateway name in the label.
  const PUBLIC_SERVICE = dataplaneService({
    name: "envoy-envoy-gateway-system-cubestack-ai-gateway-aaaaaaaa",
    gateway: "cubestack-ai-gateway",
  });
  const PRIVATE_SERVICE = dataplaneService({
    name: "envoy-envoy-gateway-system-cubestack-ai-gateway-private-bbbbbbbb",
    gateway: "cubestack-ai-gateway-private",
  });

  it("discovers both catalog Gateways, public first", async () => {
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
    vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
    // Deliberately reversed: the public Gateway is the primary base whatever
    // order the API server lists the Services in.
    listNamespacedService.mockResolvedValue({ items: [PRIVATE_SERVICE, PUBLIC_SERVICE] });
    const bases = await resolveGatewayBases();
    expect(bases.map((b) => b.name)).toEqual(["cubestack-ai-gateway", "cubestack-ai-gateway-private"]);
    expect(bases[0].url).toContain("cubestack-ai-gateway-aaaaaaaa");
    expect(bases[1].url).toContain("cubestack-ai-gateway-private-bbbbbbbb");
  });

  it("merges the two Gateways' catalogs, dropping duplicates and non-chat models", async () => {
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
    vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
    listNamespacedService.mockResolvedValue({ items: [PUBLIC_SERVICE, PRIVATE_SERVICE] });
    const fetchMock = vi.fn(async (url: string) => {
      const data = url.includes("cubestack-ai-gateway-private")
        ? [
            { id: "private-chat", owned_by: "CubeStack" },
            { id: "shared-chat" },
            { id: "text-embedding-3-large" },
          ]
        : [
            { id: "qwen38-27b", owned_by: "CubeStack" },
            { id: "shared-chat" },
            { id: "qwen-image21" },
          ];
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await gatewayCatalog()).toEqual([
      { id: "qwen38-27b", ownedBy: "CubeStack" },
      { id: "shared-chat", ownedBy: "" },
      { id: "private-chat", ownedBy: "CubeStack" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends a chat request to the Gateway that serves the model", async () => {
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
    vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
    listNamespacedService.mockResolvedValue({ items: [PUBLIC_SERVICE, PRIVATE_SERVICE] });
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const data = url.includes("cubestack-ai-gateway-private")
          ? [{ id: "private-chat" }]
          : [{ id: "qwen38-27b" }];
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await gatewayFetchForModel("private-chat", "/v1/chat/completions");
    await gatewayFetchForModel("qwen38-27b", "/v1/chat/completions");
    const chats = urls.filter((u) => u.endsWith("/v1/chat/completions"));
    expect(chats[0]).toContain("cubestack-ai-gateway-private-bbbbbbbb");
    expect(chats[1]).toContain("cubestack-ai-gateway-aaaaaaaa");
  });

  it("ignores a dataplane Service that belongs to another Gateway", async () => {
    // The bug this guards: the base was picked by the Service's name
    // (`/ai-gateway/i`), which missed Gateway/cubestack-gateway's dataplane and
    // fell back to a DNS name nothing in the cluster answers.
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
    vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
    listNamespacedService.mockResolvedValue({
      items: [dataplaneService({ name: "envoy-default-ai-gateway-27dc8f39", gateway: "ai-gateway" })],
    });
    expect(await resolveGatewayBase()).toBeNull();
  });

  it("returns null in-cluster when discovery finds nothing", async () => {
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
    vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
    listNamespacedService.mockResolvedValue({ items: [] });
    expect(await resolveGatewayBase()).toBeNull();
  });

  it("returns null in-cluster when the Service list is denied (RBAC)", async () => {
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
    vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
    const e = new Error("403 forbidden") as Error & { statusCode: number };
    e.statusCode = 403;
    listNamespacedService.mockRejectedValue(e);
    expect(await resolveGatewayBase()).toBeNull();
  });

  it("returns null off-cluster when discovery finds nothing", async () => {
    listNamespacedService.mockResolvedValue({ items: [] });
    expect(await resolveGatewayBase()).toBeNull();
  });

  // The warn is a per-process latch, so these run on a fresh module instance
  // (earlier tests in this file already sent a token over http). The plain-HTTP
  // case has to be the in-cluster base: a configured one is refused outright.
  async function freshGatewayFetch(discovered: boolean) {
    vi.stubEnv("CUBESTACK_GATEWAY_TOKEN", "tok-123");
    if (discovered) {
      vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
      vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
      listNamespacedService.mockResolvedValue({
        items: [dataplaneService()],
      });
    } else {
      vi.stubEnv("CUBESTACK_GATEWAT_URL", "https://gw.test");
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    vi.resetModules();
    return (await import("./gateway")).gatewayFetch;
  }

  it("warns once when the token would cross the in-cluster plain-HTTP base", async () => {
    const fn = await freshGatewayFetch(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fn("/v1/models");
    await fn("/v1/models");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("non-HTTPS");
    warn.mockRestore();
  });

  it("stays quiet when the gateway URL is https", async () => {
    const fn = await freshGatewayFetch(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fn("/v1/models");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("discovers the gateway base once within the cache window", async () => {
    // Discovery is a Service LIST on the cluster API, and every gateway call
    // used to pay for one.
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
    vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
    listNamespacedService.mockResolvedValue({
      items: [dataplaneService()],
    });
    await resolveGatewayBase();
    await resolveGatewayBase();
    expect(listNamespacedService).toHaveBeenCalledTimes(1);
  });

  it("aborts the service-proxy request when the caller's signal fires", async () => {
    // This path is hand-rolled (client certs rule out global fetch), so the
    // caller's timeout has to be wired to it explicitly: an endpoint that never
    // answers would otherwise hold the caller — and its stream — open.
    listNamespacedService.mockResolvedValue({
      items: [dataplaneService()],
    });
    const destroy = vi.fn();
    httpsRequest.mockReturnValue({ on: vi.fn().mockReturnThis(), write: vi.fn(), end: vi.fn(), destroy });

    expect(await gatewayCatalog(30)).toBeNull();
    expect(destroy).toHaveBeenCalled();
  });

  it("shares one Service lookup between concurrent base resolutions", async () => {
    // A cold portal answers several requests at once, and each used to run its
    // own discovery LIST.
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
    vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
    listNamespacedService.mockResolvedValue({
      items: [dataplaneService()],
    });
    const [a, b] = await Promise.all([resolveGatewayBase(), resolveGatewayBase()]);
    expect(a).toEqual(b);
    expect(listNamespacedService).toHaveBeenCalledTimes(1);
  });

  it("answers the model catalog from one gateway call within the cache window", async () => {
    vi.stubEnv("CUBESTACK_GATEWAT_URL", "http://gw.test:8080");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "qwen38-27b-fp16", owned_by: "cubestack" },
              { id: "dsv4" },
              // The gateway serves it, but it cannot answer a chat completion:
              // every reader of this catalog is a chat surface.
              { id: "qwen-image21", owned_by: "cubestack" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const first = await gatewayCatalog();
    const second = await gatewayCatalog();
    expect(first).toEqual([
      { id: "qwen38-27b-fp16", ownedBy: "cubestack" },
      { id: "dsv4", ownedBy: "" },
    ]);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers null for the catalog when the gateway cannot be reached", async () => {
    vi.stubEnv("CUBESTACK_GATEWAT_URL", "http://gw.test:8080");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(await gatewayCatalog()).toBeNull();
  });

  it("shares one gateway call between concurrent catalog reads", async () => {
    // A page reads the catalog from two places at once (the chat pane's meta and
    // the config pane's card): a cache that only remembers finished answers let
    // both wait the gateway out separately.
    vi.stubEnv("CUBESTACK_GATEWAT_URL", "http://gw.test:8080");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "qwen38-27b" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const [a, b] = await Promise.all([gatewayCatalog(), gatewayCatalog()]);
    expect(a).toEqual([{ id: "qwen38-27b", ownedBy: "" }]);
    expect(b).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("GATEWAY_NAMESPACE", () => {
  // The module-level constant is evaluated at import time, so this asserts the
  // resolution rule rather than re-reading the env: an unset/blank
  // CUBESTACK_GATEWAY_NAMESPACE falls back to envoy-gateway-system.
  it("resolves to a non-empty namespace", () => {
    expect(GATEWAY_NAMESPACE).toBe(process.env.CUBESTACK_GATEWAY_NAMESPACE?.trim() || "envoy-gateway-system");
    expect(GATEWAY_NAMESPACE.length).toBeGreaterThan(0);
  });
});

describe("GATEWAY_NAME", () => {
  // Same rule as the namespace above: an unset/blank CUBESTACK_GATEWAY_NAME
  // falls back to the name the chart and the operator default to.
  it("resolves to the platform Gateway's name", () => {
    expect(GATEWAY_NAME).toBe(process.env.CUBESTACK_GATEWAY_NAME?.trim() || "cubestack-gateway");
    expect(GATEWAY_NAME.length).toBeGreaterThan(0);
  });
});
