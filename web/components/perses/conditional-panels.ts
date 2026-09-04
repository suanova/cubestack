// Portal enforcement of per-dashboard conditional panel visibility.
//
// Perses 0.54 has no way to hide a panel based on a variable selection, so a
// dashboard spec opts in by tagging a panel's `display.description` with
// "@hide-when-specific:<variable>": the portal then drops that panel whenever
// <variable> settles on one concrete value (a GPU is picked instead of All) —
// or, on a scoped landing, immediately. The rule lives in the dashboard YAML;
// these helpers only interpret it.

import type { DashboardResource } from "@perses-dev/core";
import type { GridItemDefinition } from "@perses-dev/spec";

const PANEL_REF_PREFIX = "#/spec/panels/";
const HIDE_WHEN_SPECIFIC_RE = /@hide-when-specific:([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * Map of variable name -> panel keys whose `display.description` carries the
 * "@hide-when-specific:<variable>" marker for that variable.
 */
export function extractHideRules(dashboardResource: DashboardResource): ReadonlyMap<string, string[]> {
  const byVariable = new Map<string, string[]>();
  for (const [panelKey, panel] of Object.entries(dashboardResource.spec.panels)) {
    const marker = HIDE_WHEN_SPECIFIC_RE.exec(panel.spec.display?.description ?? "");
    if (!marker) continue;
    const variable = marker[1];
    const keys = byVariable.get(variable);
    if (keys) keys.push(panelKey);
    else byVariable.set(variable, [panelKey]);
  }
  return byVariable;
}

const COLUMNS_FALLBACK = 24;

/**
 * Pack grid items into the top-left of the grid, preserving reading order
 * (row by row, left to right). Dropping panels leaves the grid absolute-
 * positioned, so without this a hidden row leaves a blank band where it was.
 */
function packItems(
  items: GridItemDefinition[],
  columns: number,
): GridItemDefinition[] {
  const inOrder = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const packed: GridItemDefinition[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const item of inOrder) {
    if (x + item.width > columns) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    packed.push({ ...item, x, y });
    x += item.width;
    rowHeight = Math.max(rowHeight, item.height);
  }
  return packed;
}

/**
 * A copy of the dashboard resource without the given panels. Grid items whose
 * `$ref` points at a dropped panel are removed too, and the survivors are
 * repacked into the top-left so a hidden row leaves no blank band. Returns the
 * input unchanged when nothing is dropped, and never mutates the input.
 */
export function buildFilteredResource(
  dashboardResource: DashboardResource,
  keysToDrop: ReadonlySet<string>,
): DashboardResource {
  if (keysToDrop.size === 0) return dashboardResource;

  const panels = { ...dashboardResource.spec.panels };
  for (const key of keysToDrop) delete panels[key];

  const layouts = dashboardResource.spec.layouts.map((layout) => {
    // Only Grid layouts reference panels by $ref. Tabs layouts (a container of
    // grid sub-layouts) pass through untouched; none of the portal dashboards
    // use them yet.
    if (layout.kind !== "Grid") return layout;
    const items = layout.spec.items.filter(
      (item) => !keysToDrop.has(item.content.$ref.slice(PANEL_REF_PREFIX.length)),
    );
    if (items.length === layout.spec.items.length) return layout;
    // The grid's column count is the widest original row; pack against it so
    // the survivors keep filling whole rows.
    const columns = Math.max(COLUMNS_FALLBACK, ...layout.spec.items.map((item) => item.x + item.width));
    return { ...layout, spec: { ...layout.spec, items: packItems(items, columns) } };
  });

  return { ...dashboardResource, spec: { ...dashboardResource.spec, panels, layouts } };
}
