// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  credentialChoiceError,
  llmCredentialName,
  modelIdError,
  modelIdsError,
  modelKey,
  normalizeEndpoint,
  normalizeModelIds,
  providerIndex,
  providerNameError,
  sanitizeProviderName,
} from "./llm";

describe("sanitizeProviderName", () => {
  it("lowercases and reduces to a DNS-1123 label", () => {
    expect(sanitizeProviderName("  DeepSeek  ")).toBe("deepseek");
    expect(sanitizeProviderName("My_Provider/v1")).toBe("my-provider-v1");
    expect(sanitizeProviderName("--weird--")).toBe("weird");
    expect(sanitizeProviderName("  ")).toBe("");
  });

  it("drops dots (a provider name is a label, not a subdomain)", () => {
    expect(sanitizeProviderName("glm-5.2-chat")).toBe("glm-5-2-chat");
  });

  it("caps the name at 63 characters without leaving a trailing dash", () => {
    expect(sanitizeProviderName("a".repeat(80))).toBe("a".repeat(63));
    expect(sanitizeProviderName(`${"a".repeat(62)}-bc`)).toBe("a".repeat(62));
  });
});

describe("providerNameError", () => {
  it("accepts DNS-1123 labels", () => {
    expect(providerNameError("deepseek")).toBe("");
    expect(providerNameError("glm-5-2-chat")).toBe("");
    expect(providerNameError("a")).toBe("");
    expect(providerNameError("a".repeat(63))).toBe("");
  });

  it("rejects an empty name, an edge dash, a dot and an overlong name", () => {
    expect(providerNameError("")).toContain("DNS-1123 label");
    expect(providerNameError("-a")).toContain("DNS-1123 label");
    expect(providerNameError("a-")).toContain("DNS-1123 label");
    expect(providerNameError("a.b")).toContain("DNS-1123 label");
    expect(providerNameError("a".repeat(64))).toContain("DNS-1123 label");
  });
});

describe("model ids", () => {
  it("trims, drops empties and de-duplicates, keeping order", () => {
    expect(normalizeModelIds([" a ", "b", "", "a", "c"])).toEqual(["a", "b", "c"]);
  });

  it("accepts an id that is a path (OpenRouter's anthropic/claude-sonnet-4.5)", () => {
    expect(modelIdError("anthropic/claude-sonnet-4.5")).toBe("");
  });

  it("rejects the ids the CRD's CEL rule refuses", () => {
    for (const bad of ["", "*", " a", "a ", "a//b", "/a", "a/", "x".repeat(257)]) {
      expect(modelIdError(bad)).toContain("unusable");
    }
  });

  it("requires a non-empty list within the CRD's cap", () => {
    expect(modelIdsError(["a"])).toBe("");
    expect(modelIdsError([])).toContain("at least one model id");
    expect(modelIdsError(Array.from({ length: 65 }, (_, i) => `m${i}`))).toContain("at most 64");
    expect(modelIdsError(["a", "*"])).toContain("unusable");
  });
});

describe("modelKey", () => {
  it("prefixes a bare id with the provider", () => {
    expect(modelKey("cubestack", "qwen38-27b")).toBe("cubestack/qwen38-27b");
  });

  it("leaves an id that already starts with the provider unprefixed", () => {
    expect(modelKey("vllm", "vllm/qwen3-32b")).toBe("vllm/qwen3-32b");
    expect(modelKey("vllm", "VLLM/qwen3-32b")).toBe("VLLM/qwen3-32b");
  });

  it("keeps an id that merely contains the provider name intact", () => {
    expect(modelKey("vllm", "other/vllm/x")).toBe("vllm/other/vllm/x");
  });
});

describe("normalizeEndpoint", () => {
  it("strips a trailing /chat/completions (the SDK appends it itself)", () => {
    expect(normalizeEndpoint("https://api.example.com/v1/chat/completions")).toBe("https://api.example.com/v1");
  });

  it("strips trailing slashes but never invents a path prefix", () => {
    expect(normalizeEndpoint(" https://api.deepseek.com/ ")).toBe("https://api.deepseek.com");
    expect(normalizeEndpoint("http://llm.local:8080/v1")).toBe("http://llm.local:8080/v1");
  });

  it("rejects anything that is not a URL", () => {
    expect(() => normalizeEndpoint("api.example.com")).toThrow("valid URL");
    expect(() => normalizeEndpoint("")).toThrow("valid URL");
    expect(() => normalizeEndpoint("/v1")).toThrow("valid URL");
  });
});

describe("credentialChoiceError", () => {
  it("requires exactly one of apiKey / public", () => {
    expect(credentialChoiceError("sk-1", false)).toBe("");
    expect(credentialChoiceError("", true)).toBe("");
    expect(credentialChoiceError("", false)).toContain("apiKey is required");
    expect(credentialChoiceError("sk-1", true)).toContain("mutually exclusive");
  });
});

describe("llmCredentialName / providerIndex", () => {
  it("derives the Secret name from the immutable provider name", () => {
    expect(llmCredentialName("deepseek")).toBe("llm-deepseek");
  });

  it("finds a provider by name", () => {
    const providers = [{ name: "a" }, { name: "b" }];
    expect(providerIndex(providers, "b")).toBe(1);
    expect(providerIndex(providers, "zz")).toBe(-1);
    expect(providerIndex(undefined, "a")).toBe(-1);
  });
});
