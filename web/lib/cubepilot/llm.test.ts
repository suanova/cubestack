// @vitest-environment node
import { describe, expect, it } from "vitest";

import { credentialChoiceError, llmCredentialName, modelIndex, normalizeEndpoint, sanitizeModelName } from "./llm";

describe("sanitizeModelName", () => {
  it("lowercases and reduces to a DNS-ish key", () => {
    expect(sanitizeModelName("  GLM-5.2 Chat  ")).toBe("glm-5.2-chat");
    expect(sanitizeModelName("My_Model/v1")).toBe("my-model-v1");
    expect(sanitizeModelName("--weird--")).toBe("weird");
    expect(sanitizeModelName("  ")).toBe("");
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

describe("llmCredentialName / modelIndex", () => {
  it("derives the Secret name from the immutable model name", () => {
    expect(llmCredentialName("glm-5.2-chat")).toBe("llm-glm-5.2-chat");
  });

  it("finds a model by name", () => {
    const models = [{ name: "a" }, { name: "b" }];
    expect(modelIndex(models, "b")).toBe(1);
    expect(modelIndex(models, "zz")).toBe(-1);
    expect(modelIndex(undefined, "a")).toBe(-1);
  });
});
