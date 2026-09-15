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
    expect(base).toEqual({ url: "http://gw.test:8080", via: "direct" });
    expect(listNamespacedService).not.toHaveBeenCalled();
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
