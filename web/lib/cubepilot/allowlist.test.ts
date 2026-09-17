// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  KUBECTL_READ_ARG_PATTERN,
  SAFE_ARG_PATTERN,
  builtinAllowlist,
  effectiveAllowlist,
  mergeRules,
  ownedRules,
  ruleKey,
  validateRule,
} from "./allowlist";

// The platform defaults are hardcoded (reference: internal/allowlist) and must
// stay exactly the reference's set: the kubectl read-verb rule plus the
// read-only shell tools. A change here silently widens what auto-passes.

describe("builtinAllowlist", () => {
  it("is the reference's kubectl + read-only shell tools", () => {
    expect(builtinAllowlist().map((r) => r.pattern)).toEqual([
      "kubectl",
      "ls",
      "cat",
      "pwd",
      "grep",
      "head",
      "tail",
      "wc",
      "jq",
      "echo",
      "printf",
      "which",
    ]);
  });

  it("labels the builtins and marks them not owned", () => {
    const [kubectl, ls] = builtinAllowlist();
    expect(kubectl.argPattern).toBe(KUBECTL_READ_ARG_PATTERN);
    expect(kubectl.label).toContain("read-only operations");
    expect(ls.argPattern).toBe(SAFE_ARG_PATTERN);
    expect(ls.label).toBe("ls — read-only, plain args");
    expect(builtinAllowlist().every((r) => r.owned === false)).toBe(true);
  });

  it("anchors kubectl on a read verb (write subcommands cannot match)", () => {
    const re = new RegExp(KUBECTL_READ_ARG_PATTERN);
    expect(re.test("get pods -A -o wide")).toBe(true);
    expect(re.test("--context prod describe node compute-02")).toBe(true);
    expect(re.test("logs -f deploy/portal")).toBe(true);
    expect(re.test("delete pod portal-abc")).toBe(false);
    expect(re.test("apply -f x.yaml")).toBe(false);
    expect(re.test("exec -it pod -- sh")).toBe(false);
  });

  it("accepts only plain words for the shell tools", () => {
    const re = new RegExp(SAFE_ARG_PATTERN);
    expect(re.test("-la /var/log")).toBe(true);
    expect(re.test("x | rm -rf /")).toBe(false);
    expect(re.test("x; curl evil")).toBe(false);
  });
});

describe("mergeRules / ownedRules / effectiveAllowlist", () => {
  it("unions by pattern|argPattern, keeping order and dropping empties", () => {
    const merged = mergeRules(
      [{ pattern: "kubectl", argPattern: "get", owned: false }],
      [{ pattern: "helm ls", owned: true }, { pattern: "kubectl", argPattern: "get", owned: true }, { pattern: "", owned: true }],
    );
    expect(merged).toEqual([
      { pattern: "kubectl", argPattern: "get", owned: false },
      { pattern: "helm ls", owned: true },
    ]);
  });

  it("ruleKey is the reference's merge key", () => {
    expect(ruleKey({ pattern: "ls", owned: false })).toBe("ls|");
    expect(ruleKey({ pattern: "ls", argPattern: "^x", owned: false })).toBe("ls|^x");
  });

  it("sanitizes the CR payload (trim, dedupe, drop empty, no owned flag)", () => {
    expect(
      ownedRules([
        { pattern: "  helm ls  ", owned: true },
        { pattern: "helm ls", owned: true },
        { pattern: "   ", owned: true },
        { pattern: "ceph df", argPattern: " -s ", owned: true },
      ]),
    ).toEqual([{ pattern: "helm ls" }, { pattern: "ceph df", argPattern: "-s" }]);
  });

  it("puts the hardcoded defaults first and marks the caller's rules owned", () => {
    const effective = effectiveAllowlist([{ pattern: "helm ls", owned: true }]);
    expect(effective).toHaveLength(13);
    expect(effective.slice(0, 12).every((r) => r.owned === false)).toBe(true);
    expect(effective[12]).toEqual({ pattern: "helm ls", owned: true });
  });

  it("works without any own rules", () => {
    expect(effectiveAllowlist(undefined)).toHaveLength(12);
  });
});

describe("validateRule", () => {
  it("accepts an ordinary rule", () => {
    expect(validateRule({ pattern: "helm ls" })).toBeNull();
    expect(validateRule({ pattern: "ceph df", argPattern: "^\\s*-s" })).toBeNull();
    expect(validateRule({ pattern: "kubectl", argPattern: "(get|describe)\\b.*" })).toBeNull();
  });

  it("rejects an empty or whitespace-only pattern", () => {
    expect(validateRule({ pattern: "" })).toContain("pattern is required");
    expect(validateRule({ pattern: "   " })).toContain("pattern is required");
  });

  it("rejects '|' in the pattern: it is the rule-identity separator", () => {
    const reason = validateRule({ pattern: "kubectl|rm" });
    expect(reason).toContain("pattern must not contain '|'");
  });

  it("rejects an argPattern that is not a regular expression", () => {
    expect(validateRule({ pattern: "x", argPattern: "([unclosed" })).toContain("not a valid regular expression");
  });

  it("rejects an argPattern Go accepts but JavaScript's RegExp does not, naming the construct", () => {
    // Each assertion pins the CONSTRUCT, not just the rejection. Asserting only
    // the substring "does not accept" is what let a mis-ordered screen report
    // '(?P<n>.*)' as an inline-flag problem while the suite stayed green.
    expect(validateRule({ pattern: "x", argPattern: "(?i)GET" })).toContain("inline flag group");
    expect(validateRule({ pattern: "x", argPattern: "(?-i)GET" })).toContain("inline flag group");
    expect(validateRule({ pattern: "x", argPattern: "(?P<n>.*)" })).toContain("named group");
    expect(validateRule({ pattern: "x", argPattern: "[[:alpha:]]+" })).toContain("POSIX class");
    expect(validateRule({ pattern: "x", argPattern: "\\p{L}+" })).toContain("Unicode property");
    expect(validateRule({ pattern: "x", argPattern: "\\P{L}+" })).toContain("Unicode property");
  });

  it("accepts the JS spelling of a named group", () => {
    expect(validateRule({ pattern: "x", argPattern: "(?<n>.*)" })).toBeNull();
  });
});
