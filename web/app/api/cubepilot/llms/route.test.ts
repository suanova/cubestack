// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authedGet, authedRequest, bareGet } from "@/test/auth";
import { __resetStore } from "@/lib/cubepilot/store";

const { GET, POST } = await import("./route");

describe("/api/cubepilot/llms", () => {
  beforeEach(() => {
    __resetStore();
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), undefined)).status).toBe(401);
  });

  it("lists the seeded catalog", async () => {
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { llms: Array<{ name: string; keyed: boolean }> };
    expect(body.llms.map((m) => m.name)).toEqual(["glm-5.2-chat", "qwen2.5-72b", "deepseek-v4"]);
    expect(body.llms.every((m) => m.keyed)).toBe(true);
  });

  it("adds a keyed model", async () => {
    const res = await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({ name: "new-model", endpoint: "https://llm.example.com/v1", apiKey: "sk-test" }),
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { model: { name: string; keyed: boolean } };
    expect(body.model).toEqual({ name: "new-model", keyed: true, endpoint: "https://llm.example.com/v1" });
  });

  it("adds a public keyless model", async () => {
    const res = await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({ name: "open-model", endpoint: "https://open.example.com/v1", public: true }),
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { model: { keyed: boolean } }).model.keyed).toBe(false);
  });

  it("rejects keyless private endpoints, duplicates and bad bodies", async () => {
    const keyless = await POST(
      await authedRequest({ method: "POST", body: JSON.stringify({ name: "m", endpoint: "https://x/v1" }) }),
      undefined,
    );
    expect(keyless.status).toBe(400);

    const dup = await POST(
      await authedRequest({ method: "POST", body: JSON.stringify({ name: "glm-5.2-chat", endpoint: "https://x/v1", apiKey: "k" }) }),
      undefined,
    );
    expect(dup.status).toBe(400);

    expect(
      (await POST(await authedRequest({ method: "POST", body: "not-json" }), undefined)).status,
    ).toBe(400);
  });
});
