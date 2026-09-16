// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const { listNamespacedService } = vi.hoisted(() => ({ listNamespacedService: vi.fn() }));

vi.mock("@/lib/kubernetes", () => ({
  getCoreClient: () => ({ listNamespacedService }),
  getKubeConfig: () => ({ getCurrentCluster: () => ({ server: "https://k8s.test" }) }),
}));

import { GATEWAY_NAMESPACE, gatewayFetch, gatewayTokenHeader, resolveGatewayBase } from "./gateway";

describe("lib/cubepilot/gateway", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
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
    listNamespacedService.mockResolvedValue({
      items: [{ metadata: { name: "envoy-default-ai-gateway-27dc8f39" }, spec: { ports: [{ port: 8080 }] } }],
    });
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
    expect(seen.url).toBe("http://envoy-default-ai-gateway-27dc8f39.envoy-gateway-system.svc:8080/v1/models");
    expect(seen.headers).toEqual({ Authorization: "Bearer tok-123" });
  });

  it("gatewayTokenHeader is empty without a token", () => {
    expect(gatewayTokenHeader()).toEqual({});
  });

  it("uses the discovered service when found (in cluster)", async () => {
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
    vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
    listNamespacedService.mockResolvedValue({
      items: [{ metadata: { name: "envoy-default-ai-gateway-27dc8f39" }, spec: { ports: [{ port: 8080 }] } }],
    });
    const base = await resolveGatewayBase();
    expect(base).toEqual({ url: "http://envoy-default-ai-gateway-27dc8f39.envoy-gateway-system.svc:8080", via: "direct" });
  });

  it("falls back to the well-known default base in-cluster when discovery finds nothing", async () => {
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
    vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
    listNamespacedService.mockResolvedValue({ items: [] });
    const base = await resolveGatewayBase();
    expect(base).toEqual({ url: "http://envoy-default-ai-gateway.envoy-gateway-system.svc:8080", via: "direct" });
  });

  it("falls back to the default in-cluster when discovery is denied (RBAC)", async () => {
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
    vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
    const e = new Error("403 forbidden") as Error & { statusCode: number };
    e.statusCode = 403;
    listNamespacedService.mockRejectedValue(e);
    const base = await resolveGatewayBase();
    expect(base).toEqual({ url: "http://envoy-default-ai-gateway.envoy-gateway-system.svc:8080", via: "direct" });
  });

  it("returns null off-cluster when discovery finds nothing (no in-cluster default)", async () => {
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
        items: [{ metadata: { name: "envoy-default-ai-gateway-27dc8f39" }, spec: { ports: [{ port: 8080 }] } }],
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
