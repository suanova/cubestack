// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedGet, authedRequest, bareGet } from "@/test/auth";

const { listNamespacedCustomObject, getNamespacedCustomObject, createNamespacedCustomObject } = vi.hoisted(() => ({
  listNamespacedCustomObject: vi.fn(),
  getNamespacedCustomObject: vi.fn(),
  createNamespacedCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCustomObjectsClient: () => ({ listNamespacedCustomObject, getNamespacedCustomObject, createNamespacedCustomObject }),
}));

const { GET, POST } = await import("./route");

/** 404-shaped rejection, like the real client does for unknown names. */
const notFound = (what: string) => {
  const e = new Error(what) as Error & { statusCode: number };
  e.statusCode = 404;
  return Promise.reject(e);
};

const TASK_CR = {
  metadata: {
    name: "tester-task-01",
    creationTimestamp: "2026-09-10T06:00:00Z",
    annotations: { "cubepilot/display-name": "每日集群巡检" },
  },
  spec: {
    templateRef: "cluster-inspect",
    instruction: "对集群执行全量巡检:节点 Ready 状态与资源压力",
    owner: "tester",
    trigger: "Cron",
    cron: "0 6 * * *",
    state: "Enabled",
  },
  status: {
    phase: "Ready",
    lastRunTime: "2026-09-13T06:00:00Z",
    lastStatus: "success",
    nextRunTime: "2026-09-14T06:00:00Z",
  },
};

const OLDER_TASK_CR = {
  metadata: {
    name: "tester-task-99",
    creationTimestamp: "2026-09-01T06:00:00Z",
  },
  spec: {
    instruction: "检查磁盘使用率",
    owner: "tester",
    trigger: "Manual",
  },
};

/** Another user's task: the listing is owner-scoped, so it must not appear. */
const FOREIGN_TASK_CR = {
  metadata: {
    name: "platform-task-a1b2c3d4",
    // Newest of all: without the owner filter it would sort first.
    creationTimestamp: "2026-09-15T02:46:54Z",
    annotations: { "cubepilot/display-name": "每日集群巡检" },
  },
  spec: { instruction: "对 all 范围执行全量巡检", owner: "platform", trigger: "Cron", cron: "0 6 * * *", state: "Enabled" },
};

describe("/api/cubepilot/tasks", () => {
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

  it("lists tasks from CRDs, newest first", async () => {
    listNamespacedCustomObject.mockResolvedValue({ items: [OLDER_TASK_CR, FOREIGN_TASK_CR, TASK_CR] });
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<Record<string, unknown>> };
    expect(listNamespacedCustomObject.mock.calls[0][0]).toMatchObject({
      group: "ai.cubestack.io",
      version: "v1alpha1",
      namespace: "cubestack-system",
      plural: "tasks",
    });
    // Owner-scoped: the newer platform task is not the caller's, so it is gone.
    expect(body.tasks.map((t) => t.id)).toEqual(["tester-task-01", "tester-task-99"]);
    const daily = body.tasks[0];
    expect(daily).toMatchObject({
      // The display-name annotation wins over the DNS-1123 CR name.
      name: "每日集群巡检",
      prompt: "对集群执行全量巡检:节点 Ready 状态与资源压力",
      schedule: "0 6 * * *",
      templateRef: "cluster-inspect",
      enabled: true,
      creator: "tester",
      createdAt: "2026-09-10T06:00:00Z",
      lastRunAt: "2026-09-13T06:00:00Z",
      lastStatus: "success",
      nextRunAt: "2026-09-14T06:00:00Z",
    });
    // The CR without an annotation falls back to the CR name; empty state
    // reads as enabled; no status yet means no lastStatus.
    expect(body.tasks[1]).toMatchObject({ name: "tester-task-99", enabled: true, schedule: "" });
    expect(body.tasks[1].lastStatus).toBeUndefined();
  });

  it("hides tasks owned by other users", async () => {
    listNamespacedCustomObject.mockResolvedValue({ items: [FOREIGN_TASK_CR] });
    const body = (await (await GET(await authedGet(), undefined)).json()) as { tasks: unknown[] };
    expect(body.tasks).toEqual([]);
  });

  it("maps a Paused CR to enabled=false", async () => {
    listNamespacedCustomObject.mockResolvedValue({ items: [{ ...TASK_CR, spec: { ...TASK_CR.spec, state: "Paused" } }] });
    const body = (await (await GET(await authedGet(), undefined)).json()) as { tasks: Array<{ enabled: boolean }> };
    expect(body.tasks[0].enabled).toBe(false);
  });

  it("falls back to the default namespace when the env is unset", async () => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
    listNamespacedCustomObject.mockResolvedValue({ items: [] });
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    expect(listNamespacedCustomObject.mock.calls[0][0]).toMatchObject({ namespace: "cubestack-system" });
  });

  it("503s when the CRDs are not installed (404 from the API server)", async () => {
    listNamespacedCustomObject.mockImplementation(() => notFound('the server could not find the requested resource'));
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("cluster error");
  });

  it("creates a free-form task CR owned by the session user", async () => {
    createNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "tester-task-1a2b3c4d", creationTimestamp: "2026-09-14T06:00:00Z" },
      spec: { instruction: "检查磁盘使用率", owner: "tester", trigger: "Manual", state: "Enabled" },
    });
    const res = await POST(
      await authedRequest({ method: "POST", body: JSON.stringify({ name: "磁盘检查", prompt: " 检查磁盘使用率 ", schedule: "" }) }),
      undefined,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: { id: string; creator: string; schedule: string } };
    expect(body.task.id).toBe("tester-task-1a2b3c4d");
    expect(body.task.creator).toBe("tester");
    expect(body.task.schedule).toBe("");
    const call = createNamespacedCustomObject.mock.calls[0][0] as {
      namespace: string;
      plural: string;
      body: {
        metadata: { name: string; annotations: Record<string, string> };
        spec: { instruction: string; owner: string; trigger: string; cron?: string };
      };
    };
    expect(call).toMatchObject({ namespace: "cubestack-system", plural: "tasks" });
    expect(call.body.metadata.name).toMatch(/^tester-task-[0-9a-f]{8}$/);
    expect(call.body.metadata.annotations["cubepilot/display-name"]).toBe("磁盘检查");
    expect(call.body.spec).toMatchObject({ instruction: "检查磁盘使用率", owner: "tester", trigger: "Manual" });
    expect(call.body.spec.cron).toBeUndefined();
  });

  it("renders the template instruction with merged params when templateRef is given", async () => {
    getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "cluster-inspect" },
      spec: {
        instruction: "对 {{namespace}} 下全部 Ready 的 isvc 验证",
        paramsSchema: [{ name: "namespace", type: "string", default: "default" }],
        defaultCron: "0 6 * * *",
      },
    });
    createNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "tester-task-00000001", creationTimestamp: "2026-09-14T06:00:00Z" },
      spec: { instruction: "对 prod 下全部 Ready 的 isvc 验证", owner: "tester", trigger: "Cron", cron: "0 6 * * *", state: "Enabled" },
    });
    const res = await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({ name: "生产巡检", prompt: "", schedule: "0 6 * * *", templateRef: "cluster-inspect", params: { namespace: "prod" } }),
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    const call = createNamespacedCustomObject.mock.calls[0][0] as { body: { spec: { instruction: string; templateRef: string; params: Record<string, string> } } };
    expect(call.body.spec.instruction).toBe("对 prod 下全部 Ready 的 isvc 验证");
    expect(call.body.spec.templateRef).toBe("cluster-inspect");
    expect(call.body.spec.params).toEqual({ namespace: "prod" });
  });

  it("400s when the referenced template does not exist", async () => {
    getNamespacedCustomObject.mockImplementation(() => notFound('tasktemplates.ai.cubestack.io "nope" not found'));
    const res = await POST(
      await authedRequest({ method: "POST", body: JSON.stringify({ name: "t", prompt: "", schedule: "", templateRef: "nope" }) }),
      undefined,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('template "nope" not found');
  });

  it("400s on an invalid enum param value", async () => {
    getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "cluster-inspect" },
      spec: {
        instruction: "巡检 {{scope}}",
        paramsSchema: [{ name: "scope", type: "enum", default: "all", enum: ["all", "compute"] }],
      },
    });
    const res = await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({ name: "t", prompt: "", schedule: "", templateRef: "cluster-inspect", params: { scope: "bogus" } }),
      }),
      undefined,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("scope");
  });

  it("validates name, schedule and prompt", async () => {
    expect((await POST(await authedRequest({ method: "POST", body: JSON.stringify({}) }), undefined)).status).toBe(400);
    expect(
      (await POST(await authedRequest({ method: "POST", body: JSON.stringify({ name: "t", schedule: "not a cron" }) }), undefined)).status,
    ).toBe(400);
    expect((await POST(await authedRequest({ method: "POST", body: JSON.stringify({ name: "t", prompt: "  " }) }), undefined)).status).toBe(400);
    expect((await POST(await authedRequest({ method: "POST", body: "not-json" }), undefined)).status).toBe(400);
  });
});
