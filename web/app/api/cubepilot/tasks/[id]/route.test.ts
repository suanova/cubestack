// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedGet, bareGet } from "@/test/auth";

const { getNamespacedCustomObject, deleteNamespacedCustomObject } = vi.hoisted(() => ({
  getNamespacedCustomObject: vi.fn(),
  deleteNamespacedCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCustomObjectsClient: () => ({ getNamespacedCustomObject, deleteNamespacedCustomObject }),
}));

const { DELETE } = await import("./route");

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** 404-shaped rejection, like the real client does for unknown names. */
const notFound = () => {
  const e = new Error("not found") as Error & { statusCode: number };
  e.statusCode = 404;
  return Promise.reject(e);
};

const TASK_CR = {
  metadata: { name: "tester-task-01", creationTimestamp: "2026-09-10T06:00:00Z" },
  spec: { instruction: "巡检", owner: "tester", trigger: "Manual", state: "Enabled" },
};

describe("/api/cubepilot/tasks/[id]", () => {
  beforeEach(() => {
    process.env.CUBESTACK_TASKS_NAMESPACE = "cubestack-system";
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await DELETE(await bareGet(), ctx("any"))).status).toBe(401);
  });

  it("deletes the task CR", async () => {
    getNamespacedCustomObject.mockResolvedValue(TASK_CR);
    deleteNamespacedCustomObject.mockResolvedValue({});
    const res = await DELETE(await authedGet(), ctx("tester-task-01"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: "tester-task-01" });
    expect(deleteNamespacedCustomObject.mock.calls[0][0]).toMatchObject({
      group: "ai.cubestack.io",
      version: "v1alpha1",
      namespace: "cubestack-system",
      plural: "tasks",
      name: "tester-task-01",
    });
  });

  it("403s on another user's task", async () => {
    getNamespacedCustomObject.mockResolvedValue({ ...TASK_CR, spec: { ...TASK_CR.spec, owner: "someone-else" } });
    const res = await DELETE(await authedGet(), ctx("tester-task-01"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("not your task");
    expect(deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("404s for an unknown task", async () => {
    getNamespacedCustomObject.mockImplementation(() => notFound());
    expect((await DELETE(await authedGet(), ctx("nope"))).status).toBe(404);
    expect(deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("falls back to the default namespace when the env is unset", async () => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
    getNamespacedCustomObject.mockResolvedValue(TASK_CR);
    deleteNamespacedCustomObject.mockResolvedValue({});
    expect((await DELETE(await authedGet(), ctx("any"))).status).toBe(200);
    expect(getNamespacedCustomObject.mock.calls[0][0]).toMatchObject({ namespace: "cubestack-system" });
    expect(deleteNamespacedCustomObject.mock.calls[0][0]).toMatchObject({ namespace: "cubestack-system" });
  });
});
