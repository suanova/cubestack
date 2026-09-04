"use client";

import { useLayoutEffect, useMemo, useRef } from "react";

import { DashboardResource } from "@perses-dev/core";
import { useDashboardStore, useVariableDefinitionStates } from "@perses-dev/dashboards";
import { DEFAULT_ALL_VALUE } from "@perses-dev/spec";

import { buildFilteredResource, extractHideRules } from "@/components/perses/conditional-panels";

export interface DashboardConditionalPanelsProps {
  dashboardResource: DashboardResource;
  // Landing scope: a hide-rule variable name that is treated as specific from
  // the start, even while it is on All. The Overview's GPU card deep-links with
  // scope=gpu so the node rows are dropped on arrival, not only once a GPU is
  // picked. Cleared when the dashboard is chosen manually from the picker.
  scope?: string;
}

// A hide rule tagged with "@hide-when-specific:<variable>" is active when that
// variable settles on a single concrete option (e.g. gpu0) rather than All.
function isSpecificValue(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value !== DEFAULT_ALL_VALUE;
}

/**
 * Renders nothing; enforces the "@hide-when-specific" panel markers declared in
 * the dashboard YAML. Perses has no conditional panel visibility, so the portal
 * watches each tagged variable and swaps the dashboard store to a copy without
 * those panels while the variable is specific (or the landing scope names it),
 * restoring the full set on All. Living beside <Dashboard/> it has both variable
 * and dashboard-store context; setDashboard only swaps panels/layout, so
 * variable and time state survive.
 *
 * Reads the raw variable selection from the variable-definition store, not the
 * chart-facing values (useVariableValues): for All selections with a dashboard
 * customAllValue perses rewrites the resolved value to that regex (".*"), which
 * must not be mistaken for a specific pick.
 */
export function DashboardConditionalPanels({
  dashboardResource,
  scope,
}: DashboardConditionalPanelsProps) {
  const rules = useMemo(() => extractHideRules(dashboardResource), [dashboardResource]);
  const variableNames = useMemo(() => [...rules.keys()], [rules]);
  const variableStates = useVariableDefinitionStates(variableNames);
  const setDashboard = useDashboardStore((state) => state.setDashboard);

  // Stable "10,12,13" signature of the panels to drop; "" means none. Moving
  // between two specific GPUs (gpu0 -> gpu1) keeps the same drop set, so the
  // store is only swapped when the hidden set actually changes.
  const hiddenSignature = useMemo(() => {
    const dropKeys = new Set<string>();
    for (const [variableName, panelKeys] of rules) {
      const state = variableStates[variableName];
      const ruleActive =
        scope === variableName || (state && !state.loading && isSpecificValue(state.value));
      if (ruleActive) {
        for (const key of panelKeys) dropKeys.add(key);
      }
    }
    return [...dropKeys].sort().join(",");
  }, [rules, variableStates, scope]);

  // The store starts holding the full dashboard resource (PersesProvider), i.e.
  // no panels hidden, so "" is what it reflects at mount. The scope can make the
  // hidden set non-empty on the very first render, so swap whenever the set we
  // last pushed to the store differs from the current one — never rely on the
  // mount-time signature matching what the store already holds.
  const appliedRef = useRef("");

  useLayoutEffect(() => {
    if (appliedRef.current === hiddenSignature) return;
    appliedRef.current = hiddenSignature;
    setDashboard(
      hiddenSignature === ""
        ? dashboardResource
        : buildFilteredResource(dashboardResource, new Set(hiddenSignature.split(","))),
    );
  }, [hiddenSignature, dashboardResource, setDashboard]);

  return null;
}
