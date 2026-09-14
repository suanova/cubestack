// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authedGet, authedRequest, bareGet } from "@/test/auth";
import { __resetStore } from "@/lib/cubepilot/store";

const { GET, PUT } = await import("./route");

describe("/api/cubepilot/agent/config", () => {
  beforeEach(() => {
    __resetStore();
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), undefined)).status).toBe(401);
  });

  it("returns the seeded config", async () => {
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { exists: boolean; model: string; systemPrompt: string } };
    expect(body.config.exists).toBe(true);
    expect(body.config.model).toBe("glm-5.2-chat");
    expect(body.config.systemPrompt).toContain("CubeStack");
  });

  it("saves a known model and prompt", async () => {
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { model: "deepseek-v4", systemPrompt: "新提示词" } }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { model: string; systemPrompt: string } };
    expect(body.config.model).toBe("deepseek-v4");
    expect(body.config.systemPrompt).toBe("新提示词");
  });

  it("rejects an unknown model and a non-string prompt", async () => {
    const badModel = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { model: "nope" } }) }),
      undefined,
    );
    expect(badModel.status).toBe(400);
    expect(((await badModel.json()) as { error: string }).error).toBe('unknown model "nope"');

    const badPrompt = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { systemPrompt: 42 } }) }),
      undefined,
    );
    expect(badPrompt.status).toBe(400);

    expect(
      (await PUT(await authedRequest({ method: "PUT", body: "not-json" }), undefined)).status,
    ).toBe(400);
  });
});
