// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { authedRequest, bareGet } from "@/test/auth";

const { POST } = await import("./route");

/** The stubbed upstream answer: an OpenAI-compatible /models document. */
const serves = (ids: unknown[]): Response =>
  new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** A fetch stub, typed so the call's url/init can be asserted. */
function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const mock = vi.fn((input: RequestInfo | URL, init: RequestInit) => impl(String(input), init));
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** POST a body as an authenticated caller. */
async function call(payload: unknown): Promise<Response> {
  return POST(await authedRequest({ method: "POST", body: JSON.stringify(payload) }), undefined);
}

describe("/api/cubepilot/agent/llm-models", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await POST(await bareGet(), undefined)).status).toBe(401);
  });

  it("lists the ids the endpoint serves, deduped and sorted", async () => {
    const mock = stubFetch(async () => serves(["gpt-4o", "o3", "gpt-4o"]));
    const res = await call({ endpoint: "https://api.test/v1", apiKey: "sk-x" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ["gpt-4o", "o3"] });

    const [url, init] = mock.mock.calls[0];
    expect(url).toBe("https://api.test/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-x");
    // A redirect is not followed: a host the caller named must not be able to
    // bounce this request somewhere they never did.
    expect(init.redirect).toBe("manual");
  });

  it("sends no credential for a public endpoint", async () => {
    const mock = stubFetch(async () => serves(["m"]));
    const res = await call({ endpoint: "https://api.test/v1", public: true });
    expect(res.status).toBe(200);
    expect((mock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("answers an empty list when the endpoint serves nothing", async () => {
    stubFetch(async () => serves([]));
    const res = await call({ endpoint: "https://api.test/v1", apiKey: "sk-x" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [] });
  });

  it("refuses an endpoint that is not a URL, or not http(s)", async () => {
    const mock = stubFetch(async () => serves(["m"]));
    expect((await call({ endpoint: "not a url", apiKey: "sk-x" })).status).toBe(400);
    expect((await call({ endpoint: "ftp://api.test/v1", apiKey: "sk-x" })).status).toBe(400);
    expect(mock).not.toHaveBeenCalled();
  });

  it("refuses a key together with public, as the save does", async () => {
    const mock = stubFetch(async () => serves(["m"]));
    expect((await call({ endpoint: "https://api.test/v1", apiKey: "sk-x", public: true })).status).toBe(400);
    expect(mock).not.toHaveBeenCalled();
  });

  it("refuses the cloud metadata addresses", async () => {
    const mock = stubFetch(async () => serves(["m"]));
    for (const endpoint of ["http://169.254.169.254/latest/meta-data", "http://metadata.google.internal/v1"]) {
      expect((await call({ endpoint, public: true })).status).toBe(400);
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it("refuses an endpoint that would swallow the path this route appends", async () => {
    const mock = stubFetch(async () => serves(["m"]));
    // A fragment is never sent, so a trailing "#' would leave the caller naming
    // the path requested; a query puts the appended /models in the query.
    expect((await call({ endpoint: "https://api.test/v1#", apiKey: "sk-x" })).status).toBe(400);
    expect((await call({ endpoint: "https://api.test/v1?api-version=1", apiKey: "sk-x" })).status).toBe(400);
    expect(mock).not.toHaveBeenCalled();
  });

  it("reports the upstream status without its body", async () => {
    stubFetch(async () => new Response("secret upstream detail", { status: 401 }));
    const res = await call({ endpoint: "https://api.test/v1", apiKey: "sk-bad" });
    expect(res.status).toBe(502);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("401");
    expect(error).not.toContain("secret upstream detail");
  });

  it("refuses a redirect rather than following it", async () => {
    stubFetch(async () => new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } }));
    const res = await call({ endpoint: "https://api.test/v1", apiKey: "sk-x" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("redirect");
  });

  it("refuses a body over the cap", async () => {
    stubFetch(async () => new Response("{}", { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } }));
    expect((await call({ endpoint: "https://api.test/v1", apiKey: "sk-x" })).status).toBe(502);
  });

  it("reports an unreadable answer without throwing", async () => {
    stubFetch(async () => new Response("<html>not json</html>", { status: 200 }));
    expect((await call({ endpoint: "https://api.test/v1", apiKey: "sk-x" })).status).toBe(502);
  });

  it("fails when the endpoint cannot be reached", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    expect((await call({ endpoint: "https://api.test/v1", apiKey: "sk-x" })).status).toBe(502);
  });

  it("refuses an unparseable body", async () => {
    expect((await POST(await authedRequest({ method: "POST", body: "{" }), undefined)).status).toBe(400);
  });

  it("lists over plain http with a key, and reports that the key is in the clear", async () => {
    // The ordinary self-hosted case: an in-cluster gateway is http and takes a
    // credential. The platform warns about that rather than refusing it, and so
    // does this route — what the answer carries is what the card shows.
    const mock = stubFetch(async () => serves(["m"]));
    const res = await call({ endpoint: "http://vllm.svc:8000/v1", apiKey: "sk-x" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ["m"], warning: "key-over-http" });
    expect((mock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe("Bearer sk-x");
  });

  it("says nothing extra for a public http endpoint", async () => {
    stubFetch(async () => serves(["m"]));
    const res = await call({ endpoint: "http://vllm.svc:8000/v1", public: true });
    expect(await res.json()).toEqual({ models: ["m"] });
  });

  it("lists models from a plain http endpoint that needs no credential", async () => {
    const mock = stubFetch(async () => serves(["m"]));
    const res = await call({ endpoint: "http://vllm.svc:8000/v1", public: true });
    expect(res.status).toBe(200);
    expect(mock.mock.calls[0][0]).toBe("http://vllm.svc:8000/v1/models");
  });

  it("refuses loopback and link-local hosts", async () => {
    const mock = stubFetch(async () => serves(["m"]));
    for (const endpoint of ["http://127.0.0.1:8000/v1", "http://localhost:8000/v1", "http://[::1]:8000/v1", "http://[fe80::1]/v1"]) {
      expect((await call({ endpoint, public: true })).status).toBe(400);
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it("refuses fields that are not strings", async () => {
    const mock = stubFetch(async () => serves(["m"]));
    expect((await call({ endpoint: 42, apiKey: "sk-x" })).status).toBe(400);
    expect((await call({ endpoint: "https://api.test/v1", apiKey: 42 })).status).toBe(400);
    expect(mock).not.toHaveBeenCalled();
  });

  it("reports a body that fails while being read", async () => {
    stubFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"data":['));
              controller.error(new TypeError("network error"));
            },
          }),
          { status: 200 },
        ),
    );
    expect((await call({ endpoint: "https://api.test/v1", apiKey: "sk-x" })).status).toBe(502);
  });

  it("refuses a model list that is not a list", async () => {
    for (const payload of ["null", '{"data":{}}', '"str"']) {
      stubFetch(async () => new Response(payload, { status: 200 }));
      expect((await call({ endpoint: "https://api.test/v1", apiKey: "sk-x" })).status).toBe(502);
    }
  });

  it("parses what a real gateway answers", async () => {
    // Captured from a live Envoy AI Gateway: the document carries created /
    // object / owned_by next to the id, which the parse must ignore.
    const real = {
      object: "list",
      data: [
        { id: "qwen38-27b", created: 1789137059, object: "model", owned_by: "Envoy AI Gateway" },
        { id: "qwen38", created: 1789137059, object: "model", owned_by: "Envoy AI Gateway" },
        { id: "qwen-image-2512", created: 1789137059, object: "model", owned_by: "Envoy AI Gateway" },
        { id: "qwen-image-edit-2511", created: 1789137059, object: "model", owned_by: "Envoy AI Gateway" },
      ],
    };
    stubFetch(async () => new Response(JSON.stringify(real), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await call({ endpoint: "http://gateway.svc:8080/v1", public: true });
    expect(res.status).toBe(200);
    expect((await res.json()).models).toEqual(["qwen-image-2512", "qwen-image-edit-2511", "qwen38", "qwen38-27b"]);
  });
});
