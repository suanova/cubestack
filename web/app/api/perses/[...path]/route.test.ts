// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { authedRequest } from "@/test/auth";

// The route reads PERSES_SERVER_URL at module load, so each test imports the
// module after stubbing the env var.
const UPSTREAM = "http://perses.test";

/** Build an authenticated request carrying a valid session cookie. */
function makeRequest(method: string, url: string) {
  return authedRequest({ method }, url);
}

function mockUpstream(status = 200, body = "{}") {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(body, { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("perses proxy route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("forwards a valid datasource GET query to the Perses server", async () => {
    vi.stubEnv("PERSES_SERVER_URL", UPSTREAM);
    const { GET } = await import("./route");
    const upstream = mockUpstream(200, '{"status":"success"}');
    const search = "?query=up";

    const request = await makeRequest(
      "GET",
      `http://localhost/api/perses/proxy/globaldatasources/prometheus/api/v1/query_range${search}`,
    );
    const res = await GET(request, {
      params: Promise.resolve({ path: ["proxy", "globaldatasources", "prometheus", "api/v1/query_range"] }),
    });

    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe(`${UPSTREAM}/proxy/globaldatasources/prometheus/api/v1/query_range${search}`);
    expect(init?.method).toBe("GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "success" });
  });

  it("rejects a resource-list POST mutation with 405 without contacting the server", async () => {
    vi.stubEnv("PERSES_SERVER_URL", UPSTREAM);
    const { POST } = await import("./route");
    const upstream = mockUpstream();

    const request = await makeRequest("POST", "http://localhost/api/perses/api/v1/projects/demo/dashboards");
    const res = await POST(request, {
      params: Promise.resolve({ path: ["api/v1/projects/demo/dashboards"] }),
    });

    expect(res.status).toBe(405);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("allows POST on the datasource proxy path (query execution)", async () => {
    vi.stubEnv("PERSES_SERVER_URL", UPSTREAM);
    const { POST } = await import("./route");
    const upstream = mockUpstream(200, "{}");

    const request = await makeRequest("POST", "http://localhost/api/perses/proxy/globaldatasources/prometheus/api/v1/query_range");
    const res = await POST(request, {
      params: Promise.resolve({ path: ["proxy", "globaldatasources", "prometheus", "api/v1/query_range"] }),
    });

    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const [, init] = upstream.mock.calls[0]!;
    expect(init?.method).toBe("POST");
  });

  it("does not export mutation handlers (PUT/PATCH/DELETE)", async () => {
    vi.stubEnv("PERSES_SERVER_URL", UPSTREAM);
    const route = await import("./route");
    expect(route).not.toHaveProperty("PUT");
    expect(route).not.toHaveProperty("PATCH");
    expect(route).not.toHaveProperty("DELETE");
  });
});
