import { describe, expect, it } from "vitest";

import type { DashboardResource } from "@perses-dev/core";
import type { GridDefinition } from "@perses-dev/spec";

import { buildFilteredResource, extractHideRules } from "@/components/perses/conditional-panels";

// The fixtures only use Grid layouts, so the first layout's items are
// reachable; GridDefinition is what extractHideRules/buildFilteredResource
// operate on when dropping grid items.
const firstGridItems = (resource: DashboardResource) => {
  const layout = resource.spec.layouts[0] as GridDefinition;
  return layout.spec.items;
};

// Minimal dashboard resembling the GPU overview: panels tagged for hiding are
// only present in the grid layout when the pure functions allow them through.
function fixture(): DashboardResource {
  const panel = (name: string, description = "") => ({
    kind: "Panel",
    spec: {
      display: { name, description },
      plugin: { kind: "TimeSeriesChart", spec: {} },
      queries: [],
    },
  });
  return {
    kind: "Dashboard",
    metadata: {
      name: "gpu",
      project: "perses-dev",
      version: 0,
      createdAt: "0001-01-01T00:00:00Z",
      updatedAt: "0001-01-01T00:00:00Z",
    },
    spec: {
      display: { name: "GPU Overview" },
      duration: "1h",
      variables: [],
      panels: {
        "0": panel("GPU Temperature"),
        "10": panel("CPU Usage", "@hide-when-specific:gpu node CPU usage"),
        "11": panel("GPU Usage"),
        "12": panel("Memory Usage", "@hide-when-specific:gpu node memory usage"),
        "13": panel("RDMA Usage", "@hide-when-specific:gpu node RDMA usage"),
      },
      layouts: [
        {
          kind: "Grid",
          spec: {
            items: [
              { x: 0, y: 0, width: 6, height: 8, content: { $ref: "#/spec/panels/10" } },
              { x: 6, y: 0, width: 6, height: 8, content: { $ref: "#/spec/panels/11" } },
              { x: 12, y: 0, width: 6, height: 8, content: { $ref: "#/spec/panels/12" } },
              { x: 18, y: 0, width: 6, height: 8, content: { $ref: "#/spec/panels/13" } },
              { x: 0, y: 8, width: 24, height: 8, content: { $ref: "#/spec/panels/0" } },
            ],
          },
        },
      ],
    },
  } as DashboardResource;
}

const PANEL_KEYS = ["0", "10", "11", "12", "13"];

describe("extractHideRules", () => {
  it("maps each @hide-when-specific marker variable to its panel keys", () => {
    const rules = extractHideRules(fixture());
    expect([...rules.keys()]).toEqual(["gpu"]);
    expect(rules.get("gpu")).toEqual(["10", "12", "13"]);
  });

  it("returns an empty map when no panel carries a marker", () => {
    const rules = extractHideRules({
      ...fixture(),
      spec: { ...fixture().spec, panels: { "0": fixture().spec.panels["0"] } },
    });
    expect(rules.size).toBe(0);
  });
});

describe("buildFilteredResource", () => {
  it("returns the input unchanged when no panel is dropped", () => {
    const source = fixture();
    expect(buildFilteredResource(source, new Set())).toBe(source);
  });

  it("omits dropped panels and their grid refs, keeping the rest intact", () => {
    const result = buildFilteredResource(fixture(), new Set(["10", "12", "13"]));
    expect(Object.keys(result.spec.panels)).toEqual(["0", "11"]);
    expect(result.spec.layouts).toHaveLength(1);
    const refs = firstGridItems(result).map((item) => item.content.$ref);
    expect(refs).toEqual(["#/spec/panels/11", "#/spec/panels/0"]);
  });

  it("packs the survivors into the top-left so a dropped row leaves no blank band", () => {
    // Dropping every item of the top row (10..13) must pull the full-width GPU
    // panel (originally y8) up to the top rather than leave an empty row.
    const result = buildFilteredResource(fixture(), new Set(["10", "11", "12", "13"]));
    const items = firstGridItems(result);
    expect(items).toHaveLength(1);
    expect(items[0].content.$ref).toBe("#/spec/panels/0");
    expect(items[0]).toMatchObject({ x: 0, y: 0, width: 24, height: 8 });
  });

  it("repacks a partially emptied row, preserving reading order", () => {
    // Dropping the row's left halves (10 and 12) moves 11 and 13 left and up so
    // no x gap remains where the dropped panels sat.
    const result = buildFilteredResource(fixture(), new Set(["10", "12"]));
    const items = firstGridItems(result);
    expect(items.map((item) => item.content.$ref)).toEqual([
      "#/spec/panels/11",
      "#/spec/panels/13",
      "#/spec/panels/0",
    ]);
    // 11 then 13 fill the first row; the full-width 0 wraps to the next row.
    expect(items[0]).toMatchObject({ x: 0, y: 0 });
    expect(items[1]).toMatchObject({ x: 6, y: 0 });
    expect(items[2]).toMatchObject({ x: 0, y: 8 });
  });

  it("does not mutate the source resource", () => {
    const source = fixture();
    buildFilteredResource(source, new Set(["10", "13"]));
    expect(Object.keys(source.spec.panels)).toEqual(PANEL_KEYS);
    expect(firstGridItems(source)).toHaveLength(5);
  });
});
