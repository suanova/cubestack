// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { levelEnabled, log, logger } from "./log";

// The level switch is what makes a deployment debuggable: info (default) shows
// requests and warnings, debug adds every cluster/gateway call.

describe("log levels", () => {
  afterEach(() => {
    delete process.env.CUBESTACK_LOG_LEVEL;
    vi.restoreAllMocks();
  });

  it("defaults to info", () => {
    expect(levelEnabled("error")).toBe(true);
    expect(levelEnabled("warn")).toBe(true);
    expect(levelEnabled("info")).toBe(true);
    expect(levelEnabled("debug")).toBe(false);
  });

  it("honours the configured level (and ignores nonsense)", () => {
    expect(levelEnabled("debug", "debug")).toBe(true);
    expect(levelEnabled("info", "debug")).toBe(true);
    expect(levelEnabled("debug", "error")).toBe(false);
    expect(levelEnabled("warn", "error")).toBe(false);
    expect(levelEnabled("warn", "nonsense")).toBe(true); // falls back to info
  });

  it("emits one key=value line, routing by level", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CUBESTACK_LOG_LEVEL = "debug";
    logger("k8s").debug("get", { plural: "agenttemplates", namespace: "cubestack-system", name: "cubepilot" });
    expect(out).toHaveBeenCalledWith("[debug] k8s: get plural=agenttemplates namespace=cubestack-system name=cubepilot");
    log("error", "k8s", "cluster call failed", { status: 403, error: new Error("forbidden") });
    expect(err.mock.calls[0][0]).toContain('[error] k8s: cluster call failed status=403 error="Error: forbidden"');
  });

  it("stays silent below the configured level", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.CUBESTACK_LOG_LEVEL = "info";
    log("debug", "k8s", "noisy");
    expect(out).not.toHaveBeenCalled();
  });
});
