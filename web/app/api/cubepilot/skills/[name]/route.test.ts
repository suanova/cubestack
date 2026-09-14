// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authedRequest, bareGet } from "@/test/auth";
import { __resetStore } from "@/lib/cubepilot/store";

const { POST } = await import("./route");

const ctx = (name: string) => ({ params: Promise.resolve({ name }) });

describe("/api/cubepilot/skills/[name]", () => {
  beforeEach(() => {
    __resetStore();
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await POST(await bareGet(), ctx("devenv-ops"))).status).toBe(401);
  });

  it("installs and uninstalls a skill", async () => {
    const install = await POST(await authedRequest({ method: "POST", body: JSON.stringify({ action: "install" }) }), ctx("devenv-ops"));
    expect(install.status).toBe(200);
    let body = (await install.json()) as { skills: Array<{ name: string; enabled: boolean }> };
    expect(body.skills.find((s) => s.name === "devenv-ops")?.enabled).toBe(true);

    const uninstall = await POST(await authedRequest({ method: "POST", body: JSON.stringify({ action: "uninstall" }) }), ctx("devenv-ops"));
    body = (await uninstall.json()) as typeof body;
    expect(body.skills.find((s) => s.name === "devenv-ops")?.enabled).toBe(false);
  });

  it("validates the action", async () => {
    const bad = await POST(await authedRequest({ method: "POST", body: JSON.stringify({ action: "enable" }) }), ctx("devenv-ops"));
    expect(bad.status).toBe(400);
    const noBody = await POST(await authedRequest({ method: "POST", body: "not-json" }), ctx("devenv-ops"));
    expect(noBody.status).toBe(400);
  });

  it("404s for an unknown skill", async () => {
    expect((await POST(await authedRequest({ method: "POST", body: JSON.stringify({ action: "install" }) }), ctx("nope"))).status).toBe(404);
  });
});
