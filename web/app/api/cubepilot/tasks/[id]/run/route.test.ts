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

const TASK_CR = {
  metadata: { name: "alice-task-01", creationTimestamp: "2026-09-10T06:00:00Z" },
  spec: { instruction: "巡检", owner: "alice", trigger: "Manual", state: "Enabled" },
};

describe("/api/cubepilot/tasks/[id]/run", () => {
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

  it("sets the manual-run annotation with an RFC3339 timestamp", async () => {
    getNamespacedCustomObject.mockResolvedValue(TASK_CR);
    patchNamespacedCustomObject.mockResolvedValue({});
    const res = await POST(await authedRequest({ method: "POST" }), ctx("alice-task-01"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: true });
    const call = patchNamespacedCustomObject.mock.calls[0][0] as {
      namespace: string;
      plural: string;
      name: string;
      body: Array<{ op: string; path: string; value: Record<string, string> }>;
    };
    expect(call).toMatchObject({ namespace: "cubestack-system", plural: "tasks", name: "alice-task-01" });
    // JSON-Patch "add" replacing the merged annotations map.
    expect(call.body).toHaveLength(1);
    expect(call.body[0].path).toBe("/metadata/annotations");
    const stamp = call.body[0].value["cubepilot/manual-run"];
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
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
