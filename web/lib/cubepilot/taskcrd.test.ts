// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getNamespacedCustomObject } = vi.hoisted(() => ({ getNamespacedCustomObject: vi.fn() }));

vi.mock("@/lib/kubernetes", () => ({
  getCustomObjectsClient: () => ({ getNamespacedCustomObject }),
  getCoreClient: () => ({}),
}));

import { getTaskCr, k8sErrorDetails } from "./taskcrd";

/** The ApiException shape client-node v2 throws: the HTTP code on the error
 *  itself and the apiserver's Status object in `body`, as a string. */
const apiError = (body: string, code = 404) => Object.assign(new Error(`HTTP-Code: ${code}`), { code, body });

const status = (over?: Record<string, unknown>) =>
  JSON.stringify({ kind: "Status", apiVersion: "v1", status: "Failure", reason: "NotFound", code: 404, ...over });

/** What the apiserver answers for a GET of an object that is not there. */
const missingObject = (plural: string, name: string) =>
  apiError(
    status({
      message: `${plural}.ai.cubestack.io "${name}" not found`,
      details: { name, group: "ai.cubestack.io", kind: plural },
    }),
  );

describe("k8sErrorDetails", () => {
  it("returns the details an object-level NotFound carries", () => {
    // What the apiserver answers for GET .../agentinstances/admin-cubepilot.
    const e = apiError(
      status({
        message: 'agentinstances.ai.cubestack.io "admin-cubepilot" not found',
        details: { name: "admin-cubepilot", group: "ai.cubestack.io", kind: "agentinstances" },
      }),
    );
    expect(k8sErrorDetails(e)).toEqual({ name: "admin-cubepilot", group: "ai.cubestack.io", kind: "agentinstances" });
  });

  it("returns null when the Status carries no details", () => {
    // What the apiserver answers for an API group it does not serve.
    const e = apiError(status({ message: "the server could not find the requested resource" }));
    expect(k8sErrorDetails(e)).toBeNull();
  });

  it("returns null when there is no parsable Status body", () => {
    expect(k8sErrorDetails(new Error("not found"))).toBeNull();
    expect(k8sErrorDetails(apiError("not json at all"))).toBeNull();
    expect(k8sErrorDetails(null)).toBeNull();
  });
});

describe("getTaskCr", () => {
  beforeEach(() => {
    process.env.CUBESTACK_TASKS_NAMESPACE = "cubestack-system";
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
  });

  // The same two shapes the agent path distinguishes: a task that is not there
  // is an ordinary answer (the UI asks by id), only a nameless 404 (no API
  // group) means the CRDs are gone.
  it("treats a missing task as an ordinary absence, not a warning", async () => {
    getNamespacedCustomObject.mockRejectedValue(missingObject("tasks", "alice-task-1234abcd"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await getTaskCr("alice-task-1234abcd")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns when the 404 has no details: the API group (or the CRD) is gone", async () => {
    getNamespacedCustomObject.mockRejectedValue(
      apiError(status({ message: "the server could not find the requested resource" })),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await getTaskCr("alice-task-1234abcd")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
