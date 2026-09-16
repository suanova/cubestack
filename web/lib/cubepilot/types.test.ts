import { describe, expect, it } from "vitest";

import { PLATFORM_MODEL_NAME, displayModelName } from "./types";

describe("displayModelName", () => {
  it("shows only the model id of a platform-alias selection", () => {
    // "cubestack/" is internal plumbing the user never chose.
    expect(displayModelName(`${PLATFORM_MODEL_NAME}/qwen38-27b`)).toBe("qwen38-27b");
  });

  it("leaves a plain model name alone", () => {
    expect(displayModelName("glm-5.2-chat")).toBe("glm-5.2-chat");
  });

  it("keeps a name that merely starts like the alias prefix whole", () => {
    expect(displayModelName(`${PLATFORM_MODEL_NAME}-x`)).toBe(`${PLATFORM_MODEL_NAME}-x`);
    expect(displayModelName("")).toBe("");
  });
});
