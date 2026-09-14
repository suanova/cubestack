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
  metadata: { name: "alice-task-01", creationTimestamp: "2026-09-10T06:00:00Z" },
  spec: { instruction: "巡检", owner: "alice", trigger: "Manual", state: "Enabled" },
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
    const res = await DELETE(await authedGet(), ctx("alice-task-01"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: "alice-task-01" });
    expect(deleteNamespacedCustomObject.mock.calls[0][0]).toMatchObject({
      group: "ai.cubestack.io",
      version: "v1alpha1",
      namespace: "cubestack-system",
      plural: "tasks",
      name: "alice-task-01",
    });
  });

  it("404s for an unknown task", async () => {
    getNamespacedCustomObject.mockImplementation(() => notFound());
    expect((await DELETE(await authedGet(), ctx("nope"))).status).toBe(404);
    expect(deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("503s when the namespace env is unset", async () => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
    expect((await DELETE(await authedGet(), ctx("any"))).status).toBe(503);
  });
});
