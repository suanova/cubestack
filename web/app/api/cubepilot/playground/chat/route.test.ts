// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { authedRequest, bareGet } from "@/test/auth";

const { POST } = await import("./route");

const post = async (body: unknown) =>
  POST(await authedRequest({ method: "POST", body: JSON.stringify(body) }), undefined);

const SSE_BODY = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}`,
  "",
  `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

describe("/api/cubepilot/playground/chat", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await POST(await bareGet(), undefined)).status).toBe(401);
  });

  it("rejects invalid JSON", async () => {
    const res = await POST(await authedRequest({ method: "POST", body: "not json" }), undefined);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid JSON body");
  });

  it("requires a model and messages", async () => {
    expect((await post({ messages: [{ role: "user", content: "你好" }] })).status).toBe(400);
    expect((await post({ model: "m1" })).status).toBe(400);
  });

  it("proxies the gateway SSE stream to the client", async () => {
    vi.stubEnv("CUBESTACK_GATEWAT_URL", "http://gw.test:8080");
    const seen: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.url = url;
        seen.body = init?.body;
        return new Response(SSE_BODY, { status: 200, headers: { "content-type": "text/event-stream" } });
      }),
    );
    const res = await post({
      model: "qwen38-27b-fp16",
      messages: [{ role: "user", content: "你好" }],
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 1024,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(SSE_BODY);
    expect(seen.url).toBe("http://gw.test:8080/v1/chat/completions");
    const payload = JSON.parse(String(seen.body)) as Record<string, unknown>;
    expect(payload.model).toBe("qwen38-27b-fp16");
    expect(payload.stream).toBe(true);
    expect(payload.temperature).toBe(0.7);
    expect(payload.top_p).toBe(0.9);
    expect(payload.max_tokens).toBe(1024);
  });

  it("maps gateway failures to 502", async () => {
    vi.stubEnv("CUBESTACK_GATEWAT_URL", "http://gw.test:8080");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("model not found", { status: 400 })));
    const res = await post({ model: "nope", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("400");
  });
});
