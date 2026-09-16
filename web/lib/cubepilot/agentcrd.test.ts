// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getNamespacedCustomObject } = vi.hoisted(() => ({ getNamespacedCustomObject: vi.fn() }));

vi.mock("@/lib/kubernetes", () => ({
  getCustomObjectsClient: () => ({ getNamespacedCustomObject }),
  getCoreClient: () => ({}),
}));

import {
  agentInstanceName,
  baselineSkillNames,
  getOwnedAgentInstanceCr,
  platformProviderOps,
  providerRefs,
  sanitizeIdentity,
  skillEnabled,
  skillInBaseline,
  templateProviders,
  withSkillDisabled,
  withSkillEnabled,
  type AgentInstanceCr,
  type AgentTemplateCr,
  type SkillCr,
} from "./agentcrd";

const skill = (name: string, over?: Partial<SkillCr>): SkillCr => ({
  metadata: { name },
  spec: { displayName: name, visibility: "Platform" },
  status: { phase: "Available" },
  ...over,
});

const instance = (enabledSkills?: string[]): AgentInstanceCr => ({
  metadata: { name: "alice-cubepilot" },
  spec: { owner: "alice", ...(enabledSkills ? { enabledSkills } : {}) },
});

describe("sanitizeIdentity", () => {
  it("lowercases and collapses non-alphanumerics", () => {
    expect(sanitizeIdentity("Alice")).toBe("alice");
    expect(sanitizeIdentity("bob.smith_9")).toBe("bob-smith-9");
    expect(sanitizeIdentity("MiXeD Case!")).toBe("mixed-case");
  });

  it("trims dashes and falls back to user", () => {
    expect(sanitizeIdentity("--x--")).toBe("x");
    expect(sanitizeIdentity("!!!")).toBe("user");
    expect(sanitizeIdentity("")).toBe("user");
  });
});

describe("agentInstanceName", () => {
  it("is <sanitized user>-cubepilot", () => {
    expect(agentInstanceName("Alice")).toBe("alice-cubepilot");
    expect(agentInstanceName("Bob.Smith")).toBe("bob-smith-cubepilot");
  });
});

describe("skillInBaseline / baselineSkillNames", () => {
  it("baseline = Platform-visible and reachable", () => {
    expect(skillInBaseline(skill("a"))).toBe(true);
    expect(skillInBaseline(skill("a", { status: { phase: "Unreachable" } }))).toBe(false);
    expect(skillInBaseline(skill("a", { spec: { visibility: "Tenant" } }))).toBe(false);
    // visibility missing defaults to Platform (CRD default).
    expect(skillInBaseline({ metadata: { name: "a" } })).toBe(true);
  });

  it("keeps list order and drops non-baseline entries", () => {
    const names = baselineSkillNames([
      skill("b"),
      skill("a-unreachable", { status: { phase: "Unreachable" } }),
      skill("a"),
    ]);
    expect(names).toEqual(["b", "a"]);
  });
});

describe("skillEnabled", () => {
  it("no instance / empty list = the all-enabled baseline", () => {
    expect(skillEnabled(null, skill("a"))).toBe(true);
    expect(skillEnabled(instance(), skill("a"))).toBe(true);
    expect(skillEnabled(instance(), skill("x", { status: { phase: "Unreachable" } }))).toBe(false);
  });

  it("non-empty list = explicit allow-set", () => {
    expect(skillEnabled(instance(["a"]), skill("a"))).toBe(true);
    expect(skillEnabled(instance(["a"]), skill("b"))).toBe(false);
  });
});

describe("withSkillEnabled", () => {
  it("installing on the baseline is a no-op", () => {
    expect(withSkillEnabled(instance(), "b")).toEqual([]);
    expect(withSkillEnabled(null, "b")).toEqual([]);
  });

  it("installing appends once (idempotent)", () => {
    expect(withSkillEnabled(instance(["a"]), "b")).toEqual(["a", "b"]);
    expect(withSkillEnabled(instance(["a", "b"]), "b")).toEqual(["a", "b"]);
  });
});

describe("withSkillDisabled", () => {
  it("uninstalling on the baseline materializes baseline-minus-one", () => {
    expect(withSkillDisabled(instance(), "b", ["a", "b", "c"])).toEqual(["a", "c"]);
    expect(withSkillDisabled(null, "b", ["a", "b"])).toEqual(["a"]);
  });

  it("uninstalling from an explicit list just removes", () => {
    expect(withSkillDisabled(instance(["a", "b"]), "a", ["a", "b", "c"])).toEqual(["b"]);
  });
});

describe("getOwnedAgentInstanceCr", () => {
  beforeEach(() => {
    process.env.CUBESTACK_TASKS_NAMESPACE = "cubestack-system";
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
  });

  it("returns the caller's own instance", async () => {
    getNamespacedCustomObject.mockResolvedValue(instance());
    expect(await getOwnedAgentInstanceCr("alice")).toMatchObject({ spec: { owner: "alice" } });
  });

  it("treats an instance held by another owner as absent", async () => {
    // "Alice" is a different authenticated identity that sanitizes to the same
    // CR name — the collision the owner check exists for.
    getNamespacedCustomObject.mockResolvedValue({ ...instance(), spec: { owner: "Alice" } });
    expect(await getOwnedAgentInstanceCr("alice")).toBeNull();
  });

  it("returns null when the instance does not exist", async () => {
    const e = new Error("not found") as Error & { statusCode: number };
    e.statusCode = 404;
    getNamespacedCustomObject.mockRejectedValue(e);
    expect(await getOwnedAgentInstanceCr("alice")).toBeNull();
  });
});

const template = (spec: AgentTemplateCr["spec"]): AgentTemplateCr => ({ metadata: { name: "cubepilot" }, spec });

describe("templateProviders", () => {
  it("maps the provider list, marking the platform entry as system", () => {
    expect(
      templateProviders(
        template({
          providers: [
            { name: "cubestack", endpoint: "http://gw:8080/v1", models: ["qwen38-27b"] },
            { name: "deepseek", endpoint: "https://api.deepseek.com/v1", models: ["deepseek-chat"], credentialRef: { name: "llm-deepseek" } },
          ],
        }),
      ),
    ).toEqual([
      { name: "cubestack", endpoint: "http://gw:8080/v1", models: ["qwen38-27b"], keyed: false, origin: "system" },
      {
        name: "deepseek",
        endpoint: "https://api.deepseek.com/v1",
        models: ["deepseek-chat"],
        keyed: true,
        origin: "external",
      },
    ]);
  });

  it("drops entries without a name (they define no selectable ref)", () => {
    expect(templateProviders(template({ providers: [{ endpoint: "https://x/v1", models: ["m"] }] }))).toEqual([]);
    expect(templateProviders(null)).toEqual([]);
  });
});

describe("providerRefs", () => {
  it("is one <provider>/<modelId> ref per served model", () => {
    expect(providerRefs({ name: "deepseek", models: ["deepseek-chat", "deepseek-reasoner"] })).toEqual([
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
    ]);
  });

  it("leaves an id that already carries the prefix alone", () => {
    expect(providerRefs({ name: "vllm", models: ["vllm/qwen3-32b"] })).toEqual(["vllm/qwen3-32b"]);
  });
});

describe("platformProviderOps", () => {
  const ENDPOINT = "http://gw:8080/v1";

  it("adds the provider to an empty list", () => {
    expect(platformProviderOps(undefined, ENDPOINT, ["a"])).toEqual([
      { op: "add", path: "/spec/providers", value: [{ name: "cubestack", endpoint: ENDPOINT, models: ["a"] }] },
    ]);
  });

  it("appends it when the template has other providers", () => {
    expect(platformProviderOps([{ name: "deepseek" }], ENDPOINT, ["a"])).toEqual([
      { op: "add", path: "/spec/providers/-", value: { name: "cubestack", endpoint: ENDPOINT, models: ["a"] } },
    ]);
  });

  it("rewrites only what moved, and never keeps a foreign credential", () => {
    expect(
      platformProviderOps(
        [{ name: "x" }, { name: "cubestack", endpoint: "http://old:8080/v1", models: ["old"], credentialRef: { name: "someone-elses" } }],
        ENDPOINT,
        ["a"],
      ),
    ).toEqual([
      { op: "replace", path: "/spec/providers/1/endpoint", value: ENDPOINT },
      { op: "replace", path: "/spec/providers/1/models", value: ["a"] },
      { op: "remove", path: "/spec/providers/1/credentialRef" },
    ]);
  });

  it("is a no-op when the provider is already current", () => {
    expect(platformProviderOps([{ name: "cubestack", endpoint: ENDPOINT, models: ["a", "b"] }], ENDPOINT, ["a", "b"])).toEqual([]);
  });

  it("rewrites the list when the ids or their order changed", () => {
    expect(platformProviderOps([{ name: "cubestack", endpoint: ENDPOINT, models: ["b", "a"] }], ENDPOINT, ["a", "b"])).toEqual([
      { op: "replace", path: "/spec/providers/0/models", value: ["a", "b"] },
    ]);
  });
});
