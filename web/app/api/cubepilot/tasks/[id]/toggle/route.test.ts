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
  metadata: { name: "tester-task-01", creationTimestamp: "2026-09-10T06:00:00Z" },
  spec: { instruction: "巡检", owner: "tester", trigger: "Manual", ...(state ? { state } : {}) },
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
    const res = await POST(await authedRequest({ method: "POST" }), ctx("tester-task-01"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { enabled: boolean } };
    expect(body.task.enabled).toBe(false);
    expect((patchNamespacedCustomObject.mock.calls[0][0] as { body: unknown }).body).toEqual([
      { op: "add", path: "/spec/state", value: "Paused" },
    ]);
  });

  it("applies the state the client asks for", async () => {
    getNamespacedCustomObject.mockResolvedValue(TASK_CR("Enabled"));
    patchNamespacedCustomObject.mockResolvedValue(TASK_CR("Paused"));
    const res = await POST(
      await authedRequest({ method: "POST", body: JSON.stringify({ state: "Paused" }) }),
      ctx("tester-task-01"),
    );
    expect(res.status).toBe(200);
    expect((patchNamespacedCustomObject.mock.calls[0][0] as { body: unknown }).body).toEqual([
      { op: "add", path: "/spec/state", value: "Paused" },
    ]);
  });

  it("a retry of the same request does not flip the state back", async () => {
    // The first call landed (the state is already Paused); the client resent it
    // after an uncertain response.
    getNamespacedCustomObject.mockResolvedValue(TASK_CR("Paused"));
    const res = await POST(
      await authedRequest({ method: "POST", body: JSON.stringify({ state: "Paused" }) }),
      ctx("tester-task-01"),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { task: { enabled: boolean } }).task.enabled).toBe(false);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("400s on a state that is not Enabled/Paused", async () => {
    const res = await POST(
      await authedRequest({ method: "POST", body: JSON.stringify({ state: "Flipped" }) }),
      ctx("tester-task-01"),
    );
    expect(res.status).toBe(400);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("flips Paused back to Enabled", async () => {
    getNamespacedCustomObject.mockResolvedValue(TASK_CR("Paused"));
    patchNamespacedCustomObject.mockResolvedValue(TASK_CR("Enabled"));
    const res = await POST(await authedRequest({ method: "POST" }), ctx("tester-task-01"));
    const body = (await res.json()) as { task: { enabled: boolean } };
    expect(body.task.enabled).toBe(true);
    expect((patchNamespacedCustomObject.mock.calls[0][0] as { body: unknown }).body).toEqual([
      { op: "add", path: "/spec/state", value: "Enabled" },
    ]);
  });

  it("treats a missing state as Enabled (pre-CRD CRs)", async () => {
    getNamespacedCustomObject.mockResolvedValue(TASK_CR());
    patchNamespacedCustomObject.mockResolvedValue(TASK_CR("Paused"));
    await POST(await authedRequest({ method: "POST" }), ctx("tester-task-01"));
    expect((patchNamespacedCustomObject.mock.calls[0][0] as { body: unknown }).body).toEqual([
      { op: "add", path: "/spec/state", value: "Paused" },
    ]);
  });

  it("403s on another user's task", async () => {
    getNamespacedCustomObject.mockResolvedValue({ ...TASK_CR("Enabled"), spec: { ...TASK_CR("Enabled").spec, owner: "someone-else" } });
    const res = await POST(await authedRequest({ method: "POST" }), ctx("tester-task-01"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("not your task");
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("404s for an unknown task", async () => {
    getNamespacedCustomObject.mockImplementation(() => notFound());
    expect((await POST(await authedRequest({ method: "POST" }), ctx("nope"))).status).toBe(404);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("falls back to the default namespace when the env is unset", async () => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
    getNamespacedCustomObject.mockResolvedValue(TASK_CR("Paused"));
    patchNamespacedCustomObject.mockResolvedValue(TASK_CR("Enabled"));
    expect((await POST(await authedRequest({ method: "POST" }), ctx("any"))).status).toBe(200);
    expect(getNamespacedCustomObject.mock.calls[0][0]).toMatchObject({ namespace: "cubestack-system" });
    expect(patchNamespacedCustomObject.mock.calls[0][0]).toMatchObject({ namespace: "cubestack-system" });
  });
});
