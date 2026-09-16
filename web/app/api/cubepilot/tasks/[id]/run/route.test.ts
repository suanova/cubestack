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
  metadata: { name: "tester-task-01", creationTimestamp: "2026-09-10T06:00:00Z" },
  spec: { instruction: "巡检", owner: "tester", trigger: "Manual", state: "Enabled" },
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
    const res = await POST(await authedRequest({ method: "POST" }), ctx("tester-task-01"));
    // 202 Accepted: the trigger is registered, the scheduler owns execution.
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ started: true });
    const call = patchNamespacedCustomObject.mock.calls[0][0] as {
      namespace: string;
      plural: string;
      name: string;
      body: Array<{ op: string; path: string; value: Record<string, string> }>;
    };
    expect(call).toMatchObject({ namespace: "cubestack-system", plural: "tasks", name: "tester-task-01" });
    // JSON-Patch "add" on the one annotation: the map holds no other key, so
    // the pointer addresses the map itself.
    expect(call.body).toHaveLength(1);
    expect(call.body[0].path).toBe("/metadata/annotations");
    const stamp = call.body[0].value["cubepilot/manual-run"];
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it("patches only the manual-run annotation when the CR has others", async () => {
    getNamespacedCustomObject.mockResolvedValue({
      ...TASK_CR,
      metadata: { ...TASK_CR.metadata, annotations: { "cubepilot/display-name": "巡检", "other/annotation": "keep" } },
    });
    patchNamespacedCustomObject.mockResolvedValue({});
    const res = await POST(await authedRequest({ method: "POST" }), ctx("tester-task-01"));
    expect(res.status).toBe(202);
    const call = patchNamespacedCustomObject.mock.calls[0][0] as { body: Array<{ op: string; path: string; value: string }> };
    // A whole-map replace would drop anything the operator added between the
    // read and this write; the "/" in the key is escaped as "~1".
    expect(call.body).toHaveLength(1);
    expect(call.body[0].path).toBe("/metadata/annotations/cubepilot~1manual-run");
    expect(call.body[0].value).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("403s on another user's task", async () => {
    getNamespacedCustomObject.mockResolvedValue({ ...TASK_CR, spec: { ...TASK_CR.spec, owner: "someone-else" } });
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
    getNamespacedCustomObject.mockResolvedValue(TASK_CR);
    patchNamespacedCustomObject.mockResolvedValue({});
    expect((await POST(await authedRequest({ method: "POST" }), ctx("any"))).status).toBe(202);
    expect(patchNamespacedCustomObject.mock.calls[0][0]).toMatchObject({ namespace: "cubestack-system" });
  });
});
