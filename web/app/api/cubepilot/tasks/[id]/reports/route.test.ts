// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authedGet, bareGet } from "@/test/auth";
import { __resetStore, listTasks } from "@/lib/cubepilot/store";

const { GET } = await import("./route");

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/cubepilot/tasks/[id]/reports", () => {
  beforeEach(() => {
    __resetStore();
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), ctx("any"))).status).toBe(401);
  });

  it("returns the task's reports newest first", async () => {
    const daily = listTasks()[0]; // 每日集群巡检 (2 seeded runs)
    const res = await GET(await authedGet(), ctx(daily.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reports: Array<{ taskName: string; status: string; p1: number }> };
    expect(body.reports).toHaveLength(2);
    expect(body.reports[0].taskName).toBe("每日集群巡检");
    expect(body.reports.every((r) => r.status === "success")).toBe(true);
    // Newest first: the -1d run (P1: 2) precedes the -2d run (P1: 1).
    expect(body.reports[0].p1).toBe(2);
    expect(body.reports[1].p1).toBe(1);
  });

  it("404s for an unknown task", async () => {
    expect((await GET(await authedGet(), ctx("nope"))).status).toBe(404);
  });
});
