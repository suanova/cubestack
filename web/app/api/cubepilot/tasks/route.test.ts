// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authedGet, authedRequest, bareGet } from "@/test/auth";
import { __resetStore } from "@/lib/cubepilot/store";

const { GET, POST } = await import("./route");

describe("/api/cubepilot/tasks", () => {
  beforeEach(() => {
    __resetStore();
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), undefined)).status).toBe(401);
  });

  it("lists the seeded tasks with next run times", async () => {
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ name: string; nextRunAt?: string }> };
    expect(body.tasks).toHaveLength(4);
    expect(body.tasks[0].name).toBe("每日集群巡检");
    expect(body.tasks[0].nextRunAt).toBeDefined();
  });

  it("creates a free-form task as the caller", async () => {
    const res = await POST(
      await authedRequest({ method: "POST", body: JSON.stringify({ name: "磁盘检查", prompt: "检查磁盘使用率", schedule: "" }) }),
      undefined,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: { name: string; creator: string; enabled: boolean; schedule: string } };
    expect(body.task.name).toBe("磁盘检查");
    expect(body.task.creator).toBe("tester");
    expect(body.task.enabled).toBe(true);
    expect(body.task.schedule).toBe("");
  });

  it("creates a template task with a computed next run", async () => {
    const res = await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({ name: "生产巡检", prompt: "", schedule: "0 7 * * *", templateRef: "cluster-inspect" }),
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: { templateRef?: string; nextRunAt?: string } };
    expect(body.task.templateRef).toBe("cluster-inspect");
    expect(body.task.nextRunAt).toBeDefined();
  });

  it("validates the body", async () => {
    const post = async (body: unknown) =>
      POST(await authedRequest({ method: "POST", body: JSON.stringify(body) }), undefined);

    expect((await post({ prompt: "p", schedule: "" })).status).toBe(400); // no name
    expect((await post({ name: "t", schedule: "0 6 * *" })).status).toBe(400); // bad cron
    expect((await post({ name: "t", schedule: "" })).status).toBe(400); // no prompt, no template
    expect((await POST(await authedRequest({ method: "POST", body: "not-json" }), undefined)).status).toBe(400);
  });
});
