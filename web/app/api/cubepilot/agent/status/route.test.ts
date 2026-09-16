// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedGet, bareGet } from "@/test/auth";

const { getNamespacedCustomObject } = vi.hoisted(() => ({
  getNamespacedCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCustomObjectsClient: () => ({ getNamespacedCustomObject }),
}));

const { GET } = await import("./route");

/** 404-shaped rejection, like the real client does for unknown names. */
const notFound = () => {
  const e = new Error("not found") as Error & { statusCode: number };
  e.statusCode = 404;
  return Promise.reject(e);
};

describe("/api/cubepilot/agent/status", () => {
  beforeEach(() => {
    process.env.CUBESTACK_TASKS_NAMESPACE = "cubestack-system";
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), undefined)).status).toBe(401);
  });

  it("no instance → exists:false with the caller", async () => {
    getNamespacedCustomObject.mockImplementation(notFound);
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ exists: false, user: "tester" });
  });

  it("Ready instance → phase, uptime, pod and volume from the CR", async () => {
    const started = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "tester-cubepilot", creationTimestamp: started },
      spec: { owner: "tester" },
      status: {
        phase: "Ready",
        podName: "cubepilot-tester-abc12",
        pvcName: "pvc-tester",
        lastActivity: "2026-09-13T02:00:00Z",
        message: "ready",
      },
    });
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.exists).toBe(true);
    expect(body.id).toBe("tester-cubepilot");
    expect(body.phase).toBe("Ready");
    expect(body.user).toBe("tester");
    expect(body.podName).toBe("cubepilot-tester-abc12");
    expect(body.pvcName).toBe("pvc-tester");
    expect(body.lastActivity).toBe("2026-09-13T02:00:00Z");
    // ~3 minutes since creation, clamped to a whole number of seconds.
    expect(Number(body.uptimeSeconds)).toBeGreaterThanOrEqual(170);
    expect(Number(body.uptimeSeconds)).toBeLessThan(200);
  });

  it("an instance held by another owner reads as absent", async () => {
    getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "tester-cubepilot", creationTimestamp: new Date().toISOString() },
      // "Tester" is another identity that sanitizes to the same CR name.
      spec: { owner: "Tester" },
      status: { phase: "Ready", podName: "cubepilot-tester-abc12", pvcName: "pvc-tester" },
    });
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ exists: false, user: "tester" });
  });

  it("non-Ready phase → no uptime", async () => {
    getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "tester-cubepilot", creationTimestamp: new Date().toISOString() },
      spec: { owner: "tester" },
      status: { phase: "Creating", message: "pulling image" },
    });
    const body = (await (await GET(await authedGet(), undefined)).json()) as Record<string, unknown>;
    expect(body.phase).toBe("Creating");
    expect(body.uptimeSeconds).toBeUndefined();
    expect(body.message).toBe("pulling image");
  });
});
