import { describe, expect, it } from "vitest";

import { PLATFORM_MODEL_NAME, displayModelName, isPlatformProviderName } from "./types";

describe("displayModelName", () => {
  it("shows only the model id of a platform-alias selection", () => {
    // "cubestack/" is internal plumbing the user never chose.
    expect(displayModelName(`${PLATFORM_MODEL_NAME}/qwen38-27b`)).toBe("qwen38-27b");
  });

  it("shows only the model id of a per-Gateway platform selection", () => {
    // The private Gateway's provider name is plumbing too.
    expect(displayModelName(`${PLATFORM_MODEL_NAME}-private/dsv4-api`)).toBe("dsv4-api");
  });

  it("leaves a plain model name alone", () => {
    expect(displayModelName("glm-5.2-chat")).toBe("glm-5.2-chat");
  });

  it("keeps a name that merely starts like the alias prefix whole", () => {
    expect(displayModelName(`${PLATFORM_MODEL_NAME}-x`)).toBe(`${PLATFORM_MODEL_NAME}-x`);
    expect(displayModelName("")).toBe("");
  });
});

describe("isPlatformProviderName", () => {
  it("recognizes the platform's names and no others", () => {
    expect(isPlatformProviderName(PLATFORM_MODEL_NAME)).toBe(true);
    expect(isPlatformProviderName(`${PLATFORM_MODEL_NAME}-private`)).toBe(true);
    expect(isPlatformProviderName("deepseek")).toBe(false);
    expect(isPlatformProviderName("x-cubestack")).toBe(false);
  });
});
