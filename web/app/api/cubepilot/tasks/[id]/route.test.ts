// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authedGet, bareGet } from "@/test/auth";
import { __resetStore, listTasks } from "@/lib/cubepilot/store";

const { DELETE } = await import("./route");

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/cubepilot/tasks/[id]", () => {
  beforeEach(() => {
    __resetStore();
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await DELETE(await bareGet(), ctx("any"))).status).toBe(401);
  });

  it("deletes a task and its reports", async () => {
    const id = listTasks()[0].id;
    const res = await DELETE(await authedGet(), ctx(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: id });
    expect(listTasks().some((t) => t.id === id)).toBe(false);
    const gone = await DELETE(await authedGet(), ctx(id));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "task not found" });
  });

  it("404s for an unknown task", async () => {
    const res = await DELETE(await authedGet(), ctx("nope"));
    expect(res.status).toBe(404);
  });
});
