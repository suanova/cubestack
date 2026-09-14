// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authedRequest, bareGet } from "@/test/auth";
import { __resetStore, listTasks } from "@/lib/cubepilot/store";

const { POST } = await import("./route");

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/cubepilot/tasks/[id]/toggle", () => {
  beforeEach(() => {
    __resetStore();
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await POST(await bareGet(), ctx("any"))).status).toBe(401);
  });

  it("flips the enabled flag", async () => {
    const task = listTasks()[0];
    expect(task.enabled).toBe(true);
    const res = await POST(await authedRequest({ method: "POST" }), ctx(task.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { enabled: boolean } };
    expect(body.task.enabled).toBe(false);
    // Toggle back.
    const again = await POST(await authedRequest({ method: "POST" }), ctx(task.id));
    expect(((await again.json()) as { task: { enabled: boolean } }).task.enabled).toBe(true);
  });

  it("404s for an unknown task", async () => {
    expect((await POST(await authedRequest({ method: "POST" }), ctx("nope"))).status).toBe(404);
  });
});
