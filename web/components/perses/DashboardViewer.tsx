"use client";

import { useEffect, useRef, useState } from "react";

import { Box, Typography } from "@mui/material";
import { ErrorAlert, ErrorBoundary } from "@perses-dev/components";
import { DashboardResource } from "@perses-dev/core";
import { Dashboard, VariableList } from "@perses-dev/dashboards";
import { TimeRangeControls, useVariableValues } from "@perses-dev/plugin-system";

import { DashboardConditionalPanels } from "@/components/perses/DashboardConditionalPanels";
import { PersesProvider } from "@/components/perses/PersesProvider";

export interface DashboardViewerProps {
  project: string;
  dashboardName: string;
  dashboardResource: DashboardResource;
  // Left spacer for the variable toolbar, so a control the host page overlays
  // on top of it (the dashboard picker on /dashboards) is not hidden.
  variableRowSpacing?: string;
  // Landing scope for the conditional-panel rules (see DashboardConditionalPanels).
  scope?: string;
}

// A dashboard variable marked display.hidden is one the portal still resolves
// (so the charts that reference it keep filtering) but does not render as an
// editable dropdown. When it settles on exactly one option — e.g. the model
// implied by the selected inference service — surface that value as read-only
// text in the toolbar instead of dropping it out of sight.
function HiddenVariableValue({ name, label }: { name: string; label: string }) {
  const state = useVariableValues([name])[name];
  // Under an All / multi-value selection the variable resolves to more than one
  // option, so there is no single value worth displaying.
  if (
    !state ||
    state.loading ||
    typeof state.value !== "string" ||
    state.value.length === 0 ||
    !state.options ||
    state.options.length !== 1
  ) {
    return null;
  }
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: "8px", minHeight: "38px" }}>
      <Typography
        component="span"
        sx={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "text.secondary",
        }}
      >
        {label}
      </Typography>
      <Typography component="span" sx={{ fontSize: 14, fontWeight: 600 }}>
        {state.value}
      </Typography>
    </Box>
  );
}

/**
 * Read-only rendering of a Perses dashboard: the dashboard's variable toolbar
 * (the filter dropdowns defined in the dashboard spec) and its panel grid. The
 * hosting page (the dropdown on /dashboards) identifies the dashboard;
 * edit-mode machinery from the reference (OCPDashboardApp's dialogs/toolbar)
 * is skipped.
 */
export function DashboardViewer({
  project,
  dashboardName,
  dashboardResource,
  variableRowSpacing,
  scope,
}: DashboardViewerProps) {
  const hiddenVariables = dashboardResource.spec.variables.filter(
    (v) => v.spec.display?.hidden === true,
  );
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  // No TimeZoneProvider is mounted (only TimeRangeProviderBasic), so useTimeZone
  // inside the perses controls falls back to "local"; keep that as the value we
  // hand the time controls so they stay in sync with the browser's timezone.
  const [timeZone, setTimeZone] = useState("local");

  // Perses sizes each list-variable field from a character-count estimate
  // (Variable.js getWidthPx) that runs a few pixels short, so a value like the
  // inference instance "dsv4-pro-pd" has its tail clipped at the field edge.
  // Content-based CSS sizing (field-sizing) is not supported yet, so when a
  // field's inline width changes we re-measure it and widen it by the overflow
  // plus a little breathing room. Perses rewrites the width whenever the value
  // changes — exactly when the overflow can change — so watching the style
  // attribute keeps the correction in step with perses.
  useEffect(() => {
    const root = toolbarRef.current;
    if (!root) return;
    let raf = 0;
    const fix = () => {
      raf = 0;
      root.querySelectorAll<HTMLInputElement>('input[role="combobox"]').forEach((input) => {
        // Hidden variables still render but are display:none; skip anything not
        // laid out (their rect has zero width).
        if (input.getBoundingClientRect().width === 0) return;
        const overflow = input.scrollWidth - input.clientWidth;
        if (overflow <= 1) return;
        const field = input.closest<HTMLElement>(".MuiTextField-root");
        if (field) {
          field.style.width = `${field.offsetWidth + overflow + 12}px`;
        }
      });
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(fix);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return (
    <PersesProvider
      project={project}
      dashboardName={dashboardName}
      dashboardResource={dashboardResource}
    >
      <ErrorBoundary FallbackComponent={ErrorAlert}>
        <Box
          ref={toolbarRef}
          sx={{
            display: "flex",
            flexWrap: "wrap",
            gap: "16px",
            alignItems: "center",
            mb: "16px",
            ...(variableRowSpacing ? { ml: variableRowSpacing } : {}),
          }}
        >
          <VariableList />
          {hiddenVariables.map((v) => (
            <HiddenVariableValue
              key={v.spec.name}
              name={v.spec.name}
              label={v.spec.display?.name ?? v.spec.name}
            />
          ))}
          {/* Time range / refresh interval controls, right-aligned in the
              toolbar row. They read and write perses' time context (provided by
              PersesProvider's TimeRangeProviderBasic), which drives query
              re-runs and interval auto-refresh; zoom in/out is not exposed. */}
          <Box sx={{ ml: "auto", display: "flex", alignItems: "center" }}>
            <TimeRangeControls
              timeZone={timeZone}
              onTimeZoneChange={(tz) => setTimeZone(tz.value)}
              showZoomButtons={false}
            />
          </Box>
        </Box>
        <Dashboard />
        <DashboardConditionalPanels dashboardResource={dashboardResource} scope={scope} />
      </ErrorBoundary>
    </PersesProvider>
  );
}
