// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultPilotBase, pilotFetch, resolvePilotBase } from "./pilotapi";

const K8S_ENV = ["KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT"];

afterEach(() => {
  delete process.env.CUBESTACK_PILOT_URL;
  delete process.env.CUBESTACK_TASKS_NAMESPACE;
  for (const k of K8S_ENV) delete process.env[k];
  vi.unstubAllGlobals();
});

describe("resolvePilotBase", () => {
  it("prefers the CUBESTACK_PILOT_URL override (trailing slashes stripped)", () => {
    process.env.CUBESTACK_PILOT_URL = "http://127.0.0.1:3088///";
    expect(resolvePilotBase()).toBe("http://127.0.0.1:3088");
  });

  it("falls back to the in-cluster Service DNS", () => {
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    process.env.KUBERNETES_SERVICE_PORT = "443";
    expect(resolvePilotBase()).toBe("http://cubepilot-api.cubestack-system.svc:8080");
  });

  it("uses the operator namespace from CUBESTACK_TASKS_NAMESPACE", () => {
    process.env.CUBESTACK_TASKS_NAMESPACE = "ops";
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    process.env.KUBERNETES_SERVICE_PORT = "443";
    expect(resolvePilotBase()).toBe("http://cubepilot-api.ops.svc:8080");
  });

  it("is null off-cluster without an override", () => {
    expect(resolvePilotBase()).toBeNull();
  });
});

describe("defaultPilotBase", () => {
  it("points at the chart's Service name in the operator namespace", () => {
    expect(defaultPilotBase()).toBe("http://cubepilot-api.cubestack-system.svc:8080");
  });
});

describe("pilotFetch", () => {
  it("throws when the base is unresolved", async () => {
    await expect(pilotFetch("/api/v1/sessions", "alice")).rejects.toThrow("agent API base unresolved");
  });

  it("injects the caller as X-CubePilot-User and a JSON content type", async () => {
    process.env.CUBESTACK_PILOT_URL = "http://pilot.test:8080";
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await pilotFetch("/api/v1/sessions/agent%3Amain%3Aconv-1/messages", "alice", { method: "POST", body: '{"content":"hi"}' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://pilot.test:8080/api/v1/sessions/agent%3Amain%3Aconv-1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-CubePilot-User"]).toBe("alice");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe('{"content":"hi"}');
  });

  it("keeps a caller-provided content type", async () => {
    process.env.CUBESTACK_PILOT_URL = "http://pilot.test:8080";
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await pilotFetch("/api/v1/sessions", "alice", { method: "POST", body: "x", headers: { "Content-Type": "text/plain" } });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("text/plain");
  });
});
