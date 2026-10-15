// @vitest-environment node
import { describe, expect, it } from "vitest";

import { providerNameNotice } from "./provider-names";

describe("providerNameNotice", () => {
  it("flags a name the runtime installs a plugin for, and names the provider it means", () => {
    expect(providerNameNotice("qwen")).toEqual({
      kind: "reserved-plugin",
      provider: "Qwen Cloud",
      suggestion: "qwen-proxy",
    });
    expect(providerNameNotice("deepseek")).toEqual({
      kind: "reserved-plugin",
      provider: "DeepSeek",
      suggestion: "deepseek-proxy",
    });
  });

  it("matches aliases the same way, ignoring case and surrounding space", () => {
    for (const name of ["qwencloud", "modelstudio", "dashscope"]) {
      expect(providerNameNotice(name)).toEqual({
        kind: "reserved-plugin",
        provider: "Qwen Cloud",
        suggestion: `${name}-proxy`,
      });
    }
    expect(providerNameNotice("  DeepSeek ")).toEqual({
      kind: "reserved-plugin",
      provider: "DeepSeek",
      suggestion: "deepseek-proxy",
    });
  });

  it("treats a provider the runtime image integrates itself as builtin", () => {
    expect(providerNameNotice("vllm")).toEqual({ kind: "builtin" });
    expect(providerNameNotice("openai")).toEqual({ kind: "builtin" });
    // Bundled wins over the catalog: this name is in both.
    expect(providerNameNotice("opencode-go")).toEqual({ kind: "builtin" });
  });

  it("leaves every other name to the OpenAI-compatible path", () => {
    expect(providerNameNotice("my-qwen")).toEqual({ kind: "custom" });
    expect(providerNameNotice("internal-vllm")).toEqual({ kind: "custom" });
    expect(providerNameNotice("")).toEqual({ kind: "custom" });
  });
});
