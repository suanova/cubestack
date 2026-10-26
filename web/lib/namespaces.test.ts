import { afterEach, describe, expect, it } from "vitest";

import { defaultNamespaceOf, offeredNamespaces } from "./namespaces";

// Both create wizards answer this question, and they used to answer it
// differently: the dev-environment wizard preferred the platform's configured
// namespace and fell back to `default`, the inference wizard preferred
// `project-a` by name and otherwise took whatever sorted first — a platform
// namespace on a real install.

afterEach(() => {
  delete process.env.CUBESTACK_DEFAULT_NAMESPACE;
});

describe("defaultNamespaceOf", () => {
  it("prefers the namespace the platform configured", () => {
    process.env.CUBESTACK_DEFAULT_NAMESPACE = "team-b";
    expect(defaultNamespaceOf(["default", "team-b"])).toBe("team-b");
  });

  it("ignores a configured namespace the cluster does not have", () => {
    // Stale configuration is not an invitation to invent a namespace: the
    // wizard would open on a name it cannot create in.
    process.env.CUBESTACK_DEFAULT_NAMESPACE = "gone";
    expect(defaultNamespaceOf(["default", "project-a"])).toBe("default");
  });

  it("opens on `default` even when another name sorts first", () => {
    expect(defaultNamespaceOf(["ai-gateway-system", "project-a", "default"])).toBe("default");
  });

  it("falls back to the first name only when there is no `default`", () => {
    expect(defaultNamespaceOf(["project-a", "project-llm"])).toBe("project-a");
  });

  it("answers null when the cluster offers nothing", () => {
    expect(defaultNamespaceOf([])).toBeNull();
  });
});

describe("offeredNamespaces", () => {
  it("offers `default` alone", () => {
    // The rule a denylist could not keep: `monitoring` and `cuberouter` are
    // namespaces the operator creates, so every install added a name to the
    // list of ones to hide (issue #367).
    expect(
      offeredNamespaces([
        "ai-gateway-system",
        "cuberouter",
        "default",
        "kube-system",
        "monitoring",
        "project-a",
      ]),
    ).toEqual(["default"]);
  });

  it("offers the namespace the platform configured as well", () => {
    // An explicit platform decision is where its users belong, so it stays
    // selectable even though it is not `default`.
    process.env.CUBESTACK_DEFAULT_NAMESPACE = "team-b";
    expect(offeredNamespaces(["default", "project-a", "team-b"])).toEqual(["default", "team-b"]);
  });

  it("does not offer a configured namespace the cluster does not have", () => {
    process.env.CUBESTACK_DEFAULT_NAMESPACE = "gone";
    expect(offeredNamespaces(["default", "project-a"])).toEqual(["default"]);
  });

  it("offers nothing when the cluster has no `default`", () => {
    expect(offeredNamespaces(["project-a", "team-b"])).toEqual([]);
  });
});
