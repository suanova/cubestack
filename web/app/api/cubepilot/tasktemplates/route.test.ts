// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedGet, bareGet } from "@/test/auth";

const { listNamespacedCustomObject } = vi.hoisted(() => ({
  listNamespacedCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCustomObjectsClient: () => ({ listNamespacedCustomObject }),
}));

const { GET } = await import("./route");

describe("/api/cubepilot/tasktemplates", () => {
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

  it("lists templates from CRDs", async () => {
    listNamespacedCustomObject.mockResolvedValue({
      items: [
        {
          metadata: { name: "cluster-inspect" },
          spec: {
            displayName: "集群日常巡检",
            description: "节点 / Pod / GPU / 存储全量健康检查",
            instruction: "对集群执行全量巡检:{{scope}}",
            paramsSchema: [{ name: "scope", type: "enum", default: "all", enum: ["all", "compute"] }],
            defaultCron: "0 6 * * *",
            skills: ["kubectl-platform", "gpu-inspect"],
          },
        },
        {
          metadata: { name: "free-form" },
          spec: {},
        },
      ],
    });
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskTemplates: Array<Record<string, unknown>> };
    expect(listNamespacedCustomObject.mock.calls[0][0]).toMatchObject({
      group: "ai.cubestack.io",
      version: "v1alpha1",
      namespace: "cubestack-system",
      plural: "tasktemplates",
    });
    expect(body.taskTemplates).toHaveLength(2);
    expect(body.taskTemplates[0]).toMatchObject({
      name: "cluster-inspect",
      displayName: "集群日常巡检",
      description: "节点 / Pod / GPU / 存储全量健康检查",
      instruction: "对集群执行全量巡检:{{scope}}",
      defaultCron: "0 6 * * *",
      skills: ["kubectl-platform", "gpu-inspect"],
    });
    expect(body.taskTemplates[0].paramsSchema).toEqual([{ name: "scope", type: "enum", default: "all", enum: ["all", "compute"] }]);
    // An empty spec degrades to the CR name and empty collections.
    expect(body.taskTemplates[1]).toMatchObject({
      name: "free-form",
      displayName: "free-form",
      instruction: "",
      paramsSchema: [],
      skills: [],
    });
  });

  it("falls back to the default namespace when the env is unset", async () => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
    listNamespacedCustomObject.mockResolvedValue({ items: [] });
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    expect(listNamespacedCustomObject.mock.calls[0][0]).toMatchObject({ namespace: "cubestack-system" });
  });
});
