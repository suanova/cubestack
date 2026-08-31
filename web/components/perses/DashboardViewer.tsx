"use client";

import { Box } from "@mui/material";
import { ErrorAlert, ErrorBoundary } from "@perses-dev/components";
import { DashboardResource } from "@perses-dev/core";
import { Dashboard, VariableList } from "@perses-dev/dashboards";

import { PersesProvider } from "@/components/perses/PersesProvider";

export interface DashboardViewerProps {
  project: string;
  dashboardName: string;
  dashboardResource: DashboardResource;
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
}: DashboardViewerProps) {
  return (
    <PersesProvider
      project={project}
      dashboardName={dashboardName}
      dashboardResource={dashboardResource}
    >
      <ErrorBoundary FallbackComponent={ErrorAlert}>
        <Box
          sx={{
            display: "flex",
            flexWrap: "wrap",
            gap: "16px",
            alignItems: "center",
            mb: "16px",
          }}
        >
          <VariableList />
        </Box>
        <Dashboard />
      </ErrorBoundary>
    </PersesProvider>
  );
}
