// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedRequest, bareGet } from "@/test/auth";

const { getNamespacedCustomObject, patchNamespacedCustomObject } = vi.hoisted(() => ({
  getNamespacedCustomObject: vi.fn(),
  patchNamespacedCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCustomObjectsClient: () => ({ getNamespacedCustomObject, patchNamespacedCustomObject }),
}));

const { POST } = await import("./route");

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** 404-shaped rejection, like the real client does for unknown names. */
const notFound = () => {
  const e = new Error("not found") as Error & { statusCode: number };
  e.statusCode = 404;
  return Promise.reject(e);
};

const TASK_CR = (state?: string) => ({
  metadata: { name: "alice-task-01", creationTimestamp: "2026-09-10T06:00:00Z" },
  spec: { instruction: "巡检", owner: "alice", trigger: "Manual", ...(state ? { state } : {}) },
});

describe("/api/cubepilot/tasks/[id]/toggle", () => {
  beforeEach(() => {
    process.env.CUBESTACK_TASKS_NAMESPACE = "cubestack-system";
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await POST(await bareGet(), ctx("any"))).status).toBe(401);
  });

  it("flips Enabled to Paused", async () => {
    getNamespacedCustomObject.mockResolvedValue(TASK_CR("Enabled"));
    patchNamespacedCustomObject.mockResolvedValue(TASK_CR("Paused"));
    const res = await POST(await authedRequest({ method: "POST" }), ctx("alice-task-01"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { enabled: boolean } };
    expect(body.task.enabled).toBe(false);
    expect((patchNamespacedCustomObject.mock.calls[0][0] as { body: unknown }).body).toEqual([
      { op: "add", path: "/spec/state", value: "Paused" },
    ]);
  });

  it("flips Paused back to Enabled", async () => {
    getNamespacedCustomObject.mockResolvedValue(TASK_CR("Paused"));
    patchNamespacedCustomObject.mockResolvedValue(TASK_CR("Enabled"));
    const res = await POST(await authedRequest({ method: "POST" }), ctx("alice-task-01"));
    const body = (await res.json()) as { task: { enabled: boolean } };
    expect(body.task.enabled).toBe(true);
    expect((patchNamespacedCustomObject.mock.calls[0][0] as { body: unknown }).body).toEqual([
      { op: "add", path: "/spec/state", value: "Enabled" },
    ]);
  });

  it("treats a missing state as Enabled (pre-CRD CRs)", async () => {
    getNamespacedCustomObject.mockResolvedValue(TASK_CR());
    patchNamespacedCustomObject.mockResolvedValue(TASK_CR("Paused"));
    await POST(await authedRequest({ method: "POST" }), ctx("alice-task-01"));
    expect((patchNamespacedCustomObject.mock.calls[0][0] as { body: unknown }).body).toEqual([
      { op: "add", path: "/spec/state", value: "Paused" },
    ]);
  });

  it("404s for an unknown task", async () => {
    getNamespacedCustomObject.mockImplementation(() => notFound());
    expect((await POST(await authedRequest({ method: "POST" }), ctx("nope"))).status).toBe(404);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("503s when the namespace env is unset", async () => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
    expect((await POST(await authedRequest({ method: "POST" }), ctx("any"))).status).toBe(503);
  });
});
