// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { authedRequest, bareGet } from "@/test/auth";

const { POST } = await import("./route");

const post = async (body: unknown) =>
  POST(await authedRequest({ method: "POST", body: JSON.stringify(body) }), undefined);

describe("/api/cubepilot/playground/chat", () => {
  afterEach(() => {
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

  it("requires a service and text", async () => {
    expect((await post({ text: "你好" })).status).toBe(400);
    expect((await post({ service: "glm-5.2-chat" })).status).toBe(400);
  });

  it("returns 404 for unknown services", async () => {
    const res = await post({ service: "nope", text: "你好" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('service "nope" not found');
  });

  it("answers with a scripted reply filled with the service facts", async () => {
    const res = await post({ service: "glm-5.2-chat", text: "你好", turn: 0 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { reply: { text: string } };
    expect(body.reply.text).toContain("glm-5.2-chat");
    expect(body.reply.text).toContain("AI Gateway");
  });

  it("rotates the scripted reply by turn", async () => {
    const a = (await (await post({ service: "glm-5.2-chat", text: "a", turn: 0 })).json()) as {
      reply: { text: string };
    };
    const b = (await (await post({ service: "glm-5.2-chat", text: "b", turn: 1 })).json()) as {
      reply: { text: string };
    };
    expect(a.reply.text).not.toBe(b.reply.text);
  });
});
