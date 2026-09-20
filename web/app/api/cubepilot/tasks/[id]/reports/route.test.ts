// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedGet, bareGet } from "@/test/auth";

const { getNamespacedCustomObject, listNamespacedCustomObject } = vi.hoisted(() => ({
  getNamespacedCustomObject: vi.fn(),
  listNamespacedCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCustomObjectsClient: () => ({ getNamespacedCustomObject, listNamespacedCustomObject }),
}));

const { GET } = await import("./route");

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** 404-shaped rejection, like the real client does for unknown names. */
const notFound = () => {
  const e = new Error("not found") as Error & { statusCode: number };
  e.statusCode = 404;
  return Promise.reject(e);
};

const TASK_CR = {
  metadata: {
    name: "tester-task-01",
    creationTimestamp: "2026-09-10T06:00:00Z",
    annotations: { "cubepilot/display-name": "每日集群巡检" },
  },
  spec: { instruction: "巡检", owner: "tester", trigger: "Cron", cron: "0 6 * * *", state: "Enabled" },
};

const RUN = (over: Record<string, unknown> = {}) => ({
  metadata: { name: "run-00000001", creationTimestamp: "2026-09-13T06:00:00Z" },
  spec: { creatorTaskRef: { name: "tester-task-01" }, trigger: "Cron" },
  status: { phase: "Completed", startedAt: "2026-09-13T06:00:00Z", finishedAt: "2026-09-13T06:04:00Z" },
  ...over,
});

describe("/api/cubepilot/tasks/[id]/reports", () => {
  beforeEach(() => {
    process.env.CUBESTACK_TASKS_NAMESPACE = "cubestack-system";
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), ctx("any"))).status).toBe(401);
  });

  it("403s on another user's task", async () => {
    getNamespacedCustomObject.mockResolvedValue({ ...TASK_CR, spec: { ...TASK_CR.spec, owner: "someone-else" } });
    const res = await GET(await authedGet(), ctx("tester-task-01"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("not your task");
    expect(listNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("404s for an unknown task", async () => {
    getNamespacedCustomObject.mockImplementation(() => notFound());
    expect((await GET(await authedGet(), ctx("nope"))).status).toBe(404);
  });

  it("maps TaskRun CRs to reports, newest first", async () => {
    getNamespacedCustomObject.mockResolvedValue(TASK_CR);
    listNamespacedCustomObject.mockResolvedValue({
      items: [
        RUN({
          metadata: { name: "run-aaa", creationTimestamp: "2026-09-12T06:00:00Z" },
          spec: { creatorTaskRef: { name: "tester-task-01" }, trigger: "Cron" },
          status: {
            phase: "Completed",
            startedAt: "2026-09-12T06:00:00Z",
            finishedAt: "2026-09-12T06:04:00Z",
            content: "# 集群日常巡检报告\n\n**24 / 26 项通过**",
          },
        }),
        RUN({
          metadata: { name: "run-bbb", creationTimestamp: "2026-09-13T06:00:00Z" },
          spec: { creatorTaskRef: { name: "tester-task-01" }, trigger: "Manual" },
          status: {
            phase: "Failed",
            startedAt: "2026-09-13T06:00:00Z",
            finishedAt: "2026-09-13T06:01:22Z",
            content: "# 巡检失败",
            error: "pre-check timed out",
          },
        }),
      ],
    });
    const res = await GET(await authedGet(), ctx("tester-task-01"));
    expect(res.status).toBe(200);
    // TaskRuns are selected by the cubepilot/task label.
    expect(listNamespacedCustomObject.mock.calls[0][0]).toMatchObject({
      namespace: "cubestack-system",
      plural: "taskruns",
      labelSelector: "cubepilot/task=tester-task-01",
    });
    const body = (await res.json()) as { reports: Array<Record<string, unknown>> };
    expect(body.reports.map((r) => r.id)).toEqual(["run-bbb", "run-aaa"]);
    const latest = body.reports[0];
    expect(latest).toMatchObject({
      taskId: "tester-task-01",
      taskName: "每日集群巡检", // display-name of the task CR
      trigger: "Manual",
      status: "failed",
      startedAt: "2026-09-13T06:00:00Z",
      finishedAt: "2026-09-13T06:01:22Z",
      content: "# 巡检失败",
    });
    // No severity counts on the projection: the CRD's status carries none, and
    // a `summary` written into it would be pruned by the API server.
    expect(latest).not.toHaveProperty("p0");
    expect(body.reports[1]).toMatchObject({ status: "success", trigger: "Cron" });
  });

  it("reports a Pending run as running with a creationTimestamp start", async () => {
    getNamespacedCustomObject.mockResolvedValue(TASK_CR);
    listNamespacedCustomObject.mockResolvedValue({
      items: [
        {
          metadata: { name: "run-pending", creationTimestamp: "2026-09-14T06:00:00Z" },
          spec: { creatorTaskRef: { name: "tester-task-01" }, trigger: "Manual" },
          status: { phase: "Pending" },
        },
      ],
    });
    const body = (await (await GET(await authedGet(), ctx("tester-task-01"))).json()) as {
      reports: Array<Record<string, unknown>>;
    };
    expect(body.reports[0]).toMatchObject({ status: "running", startedAt: "2026-09-14T06:00:00Z", finishedAt: "" });
  });

  it("falls back to the default namespace when the env is unset", async () => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
    getNamespacedCustomObject.mockResolvedValue(TASK_CR);
    listNamespacedCustomObject.mockResolvedValue({ items: [] });
    expect((await GET(await authedGet(), ctx("any"))).status).toBe(200);
    expect(listNamespacedCustomObject.mock.calls[0][0]).toMatchObject({ namespace: "cubestack-system" });
  });
});
