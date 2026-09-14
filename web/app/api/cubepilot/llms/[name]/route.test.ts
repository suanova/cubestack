// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authedRequest, bareGet } from "@/test/auth";
import { __resetStore } from "@/lib/cubepilot/store";

const { PUT, DELETE } = await import("./route");

const ctx = (name: string) => ({ params: Promise.resolve({ name }) });

describe("/api/cubepilot/llms/[name]", () => {
  beforeEach(() => {
    __resetStore();
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await PUT(await bareGet(), ctx("glm-5.2-chat"))).status).toBe(401);
    expect((await DELETE(await bareGet(), ctx("glm-5.2-chat"))).status).toBe(401);
  });

  it("updates the endpoint and keeps the credential", async () => {
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ endpoint: "https://new.example.com/v1" }) }),
      ctx("glm-5.2-chat"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: { name: string; endpoint: string; keyed: boolean } };
    expect(body.model).toEqual({ name: "glm-5.2-chat", endpoint: "https://new.example.com/v1", keyed: true });
  });

  it("flips the keyed state from the public flag", async () => {
    const pub = await PUT(await authedRequest({ method: "PUT", body: JSON.stringify({ public: true }) }), ctx("qwen2.5-72b"));
    expect(((await pub.json()) as { model: { keyed: boolean } }).model.keyed).toBe(false);
    // Re-keying requires an apiKey.
    const noKey = await PUT(await authedRequest({ method: "PUT", body: JSON.stringify({ public: false }) }), ctx("qwen2.5-72b"));
    expect(noKey.status).toBe(400);
    const keyed = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ public: false, apiKey: "sk-again" }) }),
      ctx("qwen2.5-72b"),
    );
    expect(((await keyed.json()) as { model: { keyed: boolean } }).model.keyed).toBe(true);
  });

  it("404s PUTs for unknown models", async () => {
    expect((await PUT(await authedRequest({ method: "PUT", body: JSON.stringify({}) }), ctx("nope"))).status).toBe(404);
  });

  it("refuses to delete the selected model", async () => {
    const res = await DELETE(await authedRequest({ method: "DELETE" }), ctx("glm-5.2-chat"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('model "glm-5.2-chat" is selected by your instance');
  });

  it("deletes an unselected model", async () => {
    const res = await DELETE(await authedRequest({ method: "DELETE" }), ctx("deepseek-v4"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: "deepseek-v4" });
    const again = await DELETE(await authedRequest({ method: "DELETE" }), ctx("deepseek-v4"));
    expect(again.status).toBe(404);
  });
});
