import { describe, expect, it } from "vitest";

import { isActive } from "./nav";

describe("isActive", () => {
  it("marks / active only on the exact root path", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/", "/dashboards")).toBe(false);
    expect(isActive("/", "/overview")).toBe(false);
  });

  it("marks /dashboards active on the landing and every dashboard page", () => {
    expect(isActive("/dashboards", "/dashboards")).toBe(true);
    expect(isActive("/dashboards", "/dashboards/metax-gpu")).toBe(true);
    expect(isActive("/dashboards", "/dashboards/inference-service-dashboard")).toBe(true);
    expect(
      isActive("/dashboards", "/dashboards/kubernetes-node-resources-overview"),
    ).toBe(true);
    expect(isActive("/dashboards", "/")).toBe(false);
  });

  it("never marks non-route modules active", () => {
    expect(isActive("/inference-services", "/inference-services")).toBe(false);
    expect(isActive("/devenv", "/dashboards")).toBe(false);
  });
});
