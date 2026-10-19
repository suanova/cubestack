// @vitest-environment node
import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries } from "@/lib/i18n/dictionaries";

import { authedRequest, bareGet } from "@/test/auth";

const { getNamespacedCustomObject } = vi.hoisted(() => ({
  getNamespacedCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/kubernetes")>()),
  getCustomObjectsClient: () => ({ getNamespacedCustomObject }),
}));

const ENV_URL = "http://localhost/api/devenvironments/env-values?namespace=project-a&name=jupyter-nlp-ln";

/**
 * A failed k8s client call, as @kubernetes/client-node 2.x raises it: its
 * generated `ApiException` carries the status on `.code` (see the ssh-key route
 * test for why the fixture matters to the 404 path).
 */
function httpError(code: number) {
  return Object.assign(new Error(`HTTP-Code: ${code}`), { code });
}

describe("GET /api/devenvironments/env-values", () => {
  beforeEach(() => {
    getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "jupyter-nlp-ln", namespace: "project-a" },
      spec: {
        runtime: {
          env: [
            { name: "HF_TOKEN", value: "hf_xxx" },
            // A valueFrom has no literal to hand out: its value lives in the
            // Secret/ConfigMap the summary already names.
            { name: "OPS_KEY", valueFrom: { secretKeyRef: { name: "ops", key: "key" } } },
            { name: "EMPTY" },
          ],
        },
      },
    });
  });
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns only the environment's literal values, uncached", async () => {
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(200);
    // Values can be credentials: no cache may keep them. An entry with no value
    // and no source is an empty value, not a literal to fetch.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ values: { HF_TOKEN: "hf_xxx" } });
    expect(getNamespacedCustomObject).toHaveBeenCalledWith({
      group: "ai.cubestack.io",
      version: "v1alpha1",
      plural: "devenvironments",
      namespace: "project-a",
      name: "jupyter-nlp-ln",
    });
  });

  it("refuses a request that names no environment", async () => {
    const { GET } = await import("./route");
    const res = await GET(
      await authedRequest({ method: "GET" }, "http://localhost/api/devenvironments/env-values?namespace=project-a"),
      undefined,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "requestInvalid" });
    expect(getNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("answers nameMissing when the environment is gone", async () => {
    getNamespacedCustomObject.mockRejectedValue(httpError(404));
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "nameMissing", params: { name: "jupyter-nlp-ln" } });
  });

  it("answers envUnreadable when the cluster read itself fails", async () => {
    getNamespacedCustomObject.mockRejectedValue(httpError(500));
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "envUnreadable" });
  });

  it("rejects a request with no session", async () => {
    const { GET } = await import("./route");
    const res = await GET(await bareGet(), undefined);
    expect(res.status).toBe(401);
  });

  it("has a dictionary sentence for every code it can answer with", async () => {
    const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
    const codes = [...source.matchAll(/refuse\("(\w+)"/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThanOrEqual(3);
    for (const code of new Set(codes)) {
      expect(dictionaries["zh-CN"], `dev.err.${code}`).toHaveProperty(`dev.err.${code}`);
    }
  });
});
