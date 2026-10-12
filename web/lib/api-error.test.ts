import { describe, expect, it } from "vitest";

import { validationMessage } from "./api-error";
import { dictionaries } from "./i18n/dictionaries";

/** The dictionary lookup `useI18n` performs, without a React tree. */
function t(locale: "zh-CN" | "zh-TW" | "en") {
  return (key: keyof (typeof dictionaries)["zh-CN"], params?: Record<string, string | number>) => {
    const template = dictionaries[locale][key];
    return params ? template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : template;
  };
}

describe("validationMessage", () => {
  it("renders the sentence for a code, in the user's language", () => {
    // What the route answers a duplicate create with, in each locale the portal
    // ships. The sentence is the console's; the route carries only the code.
    const body = { error: "nameTaken", params: { name: "r2-web" } };
    expect(validationMessage(t("zh-CN"), body, 400, "dev")).toBe("环境 'r2-web' 已存在。");
    expect(validationMessage(t("zh-TW"), body, 400, "dev")).toBe("環境 'r2-web' 已存在。");
    expect(validationMessage(t("en"), body, 400, "dev")).toBe("The environment 'r2-web' already exists.");
  });

  it("fills every value the sentence needs", () => {
    // The list-valued bounds are parameters, not literals: the route states the
    // enum it enforces and the dictionary states how it reads.
    expect(validationMessage(t("en"), { error: "typeInvalid", params: { types: "jupyter / ssh" } }, 400, "dev")).toBe(
      "type must be one of jupyter / ssh.",
    );
    expect(validationMessage(t("en"), { error: "runAsIdInvalid", params: { field: "runAsGroup", max: 2147483647 } }, 400, "dev")).toBe(
      "runAsGroup must be a whole number between 0 and 2147483647.",
    );
    expect(validationMessage(t("zh-CN"), { error: "portInUse", params: { port: 9000 } }, 400, "dev")).toContain("9000");
  });

  it("reads the codes of the inference routes from their own space", () => {
    // `namespaceMissing` exists under both prefixes, because the two routes name
    // different objects and the portal says so in each one's words.
    expect(validationMessage(t("en"), { error: "namespaceMissing", params: { namespace: "missing" } }, 400, "inf")).toBe(
      "The namespace 'missing' does not exist.",
    );
    expect(validationMessage(t("en"), { error: "overrideAboveMax", params: { key: "replicas", max: 8 } }, 400, "inf")).toBe(
      "The override 'replicas' is above its maximum of 8.",
    );
  });

  it("names the code rather than inventing a sentence it does not have", () => {
    // A route newer than this bundle can send a code this build has never heard
    // of. A bare code is a poor sentence and an honest one; "HTTP 400" names
    // nothing at all.
    expect(validationMessage(t("en"), { error: "brandNewRefusal", params: { x: 1 } }, 400, "dev")).toBe("brandNewRefusal");
  });

  it("falls back to the status when the body carries no code", () => {
    expect(validationMessage(t("en"), {}, 502, "dev")).toBe("HTTP 502");
    expect(validationMessage(t("en"), { error: "" }, 500, "inf")).toBe("HTTP 500");
  });
});
