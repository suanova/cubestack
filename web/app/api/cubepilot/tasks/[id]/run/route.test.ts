// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authedRequest, bareGet } from "@/test/auth";
import { __resetStore, listReports, listTasks } from "@/lib/cubepilot/store";

const { POST } = await import("./route");

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/cubepilot/tasks/[id]/run", () => {
  beforeEach(() => {
    __resetStore();
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await POST(await bareGet(), ctx("any"))).status).toBe(401);
  });

  it("starts a simulated run", async () => {
    const task = listTasks()[0];
    const before = listReports(task.id).length;
    const res = await POST(await authedRequest({ method: "POST" }), ctx(task.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: true });
    const reports = listReports(task.id);
    expect(reports).toHaveLength(before + 1);
    expect(reports[0].status).toBe("running");
    expect(reports[0].trigger).toBe("Manual");
  });

  it("404s for an unknown task", async () => {
    expect((await POST(await authedRequest({ method: "POST" }), ctx("nope"))).status).toBe(404);
  });
});
