"use client";

// Set window.PERSES_APP_CONFIG / window.PERSES_PLUGIN_ASSETS_PATH before any
// Perses code runs — the plugin system reads them to resolve the API and plugin
// bundle URLs (the reference app sets them via webpack DefinePlugin).
import "@/lib/perses/config";

import { ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ChartsProvider, SnackbarProvider } from "@perses-dev/components";
import { DashboardResource, TimeRangeValue } from "@perses-dev/core";
import {
  DashboardProvider,
  DatasourceStoreProvider,
  PanelFocusProvider,
  VariableProvider,
} from "@perses-dev/dashboards";
import {
  DataQueriesProvider,
  PluginRegistry,
  remotePluginLoader,
  RouterProvider,
  TimeRangeProviderBasic,
  usePluginBuiltinVariableDefinitions,
  ValidationProvider,
} from "@perses-dev/plugin-system";
import { BuiltinVariableDefinition } from "@perses-dev/spec";
import { forwardRef, ReactNode, useMemo } from "react";
import type { AnchorHTMLAttributes, RefAttributes } from "react";

import { PortalDatasourceApi } from "@/lib/perses/datasource-api";
import {
  buildPlatformChartsTheme,
  buildPlatformMuiTheme,
  usePlatformTheme,
} from "@/lib/perses/theme";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

// Perses's RouterProvider is built around react-router's <Link>, which navigates
// with `to`. The dashboard is rendered inside a react-18 island with no Next
// router, so navigate to `to` directly with a plain anchor.
type RouterLinkProps = { to: string } & AnchorHTMLAttributes<HTMLAnchorElement> &
  RefAttributes<HTMLAnchorElement>;

const PlainLink = forwardRef<HTMLAnchorElement, RouterLinkProps>(function PlainLink(
  { to, children, ...anchorProps },
  ref,
) {
  return (
    <a href={to} ref={ref} {...anchorProps}>
      {children}
    </a>
  );
});

export interface PersesProviderProps {
  project: string;
  dashboardName: string;
  dashboardResource: DashboardResource;
  children: ReactNode;
}

/**
 * Provider chain for rendering a read-only Perses dashboard, ported from the
 * monitoring-plugin's PersesWrapper (ThemeProvider -> RouterProvider ->
 * ChartsProvider -> SnackbarProvider -> PluginRegistry -> per-dashboard
 * providers -> <Dashboard>). The WithQueryParams variants are replaced with the
 * plain providers because there is no react-router URL state in this portal.
 */
export function PersesProvider({
  project,
  dashboardName,
  dashboardResource,
  children,
}: PersesProviderProps) {
  const mode = usePlatformTheme();
  const muiTheme = useMemo(() => buildPlatformMuiTheme(mode), [mode]);
  const chartsTheme = useMemo(() => buildPlatformChartsTheme(mode), [mode]);
  const pluginLoader = useMemo(
    () => remotePluginLoader({ baseURL: "/api/perses", apiPrefix: "/api/perses" }),
    [],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={muiTheme}>
        <RouterProvider
          RouterComponent={PlainLink}
          navigate={(to) => history.pushState(null, "", to)}
        >
          <ChartsProvider chartsTheme={chartsTheme}>
            <SnackbarProvider>
              <PluginRegistry pluginLoader={pluginLoader}>
                <DashboardProviders
                  project={project}
                  dashboardName={dashboardName}
                  dashboardResource={dashboardResource}
                >
                  {children}
                </DashboardProviders>
              </PluginRegistry>
            </SnackbarProvider>
          </ChartsProvider>
        </RouterProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

interface DashboardProvidersProps {
  project: string;
  dashboardName: string;
  dashboardResource: DashboardResource;
  children: ReactNode;
}

function DashboardProviders({
  project,
  dashboardName,
  dashboardResource,
  children,
}: DashboardProvidersProps) {
  const { data: builtinDefinitions } = usePluginBuiltinVariableDefinitions();
  const datasourceApi = useMemo(() => new PortalDatasourceApi(), []);

  const builtinVariables = useMemo(() => {
    const result: BuiltinVariableDefinition[] = [
      {
        kind: "BuiltinVariable",
        spec: {
          name: "__dashboard",
          value: () => dashboardName,
          source: "Dashboard",
          display: {
            name: "__dashboard",
            description: "The name of the current dashboard",
            hidden: true,
          },
        },
      },
      {
        kind: "BuiltinVariable",
        spec: {
          name: "__project",
          value: () => project,
          source: "Dashboard",
          display: {
            name: "__project",
            description: "The name of the current dashboard project",
            hidden: true,
          },
        },
      },
    ];
    if (builtinDefinitions) {
      result.push(...builtinDefinitions);
    }
    return result;
  }, [project, dashboardName, builtinDefinitions]);

  const initialTimeRange = useMemo<TimeRangeValue>(
    () => ({ pastDuration: dashboardResource.spec.duration ?? "30m" }),
    [dashboardResource],
  );

  return (
    <TimeRangeProviderBasic
      initialTimeRange={initialTimeRange}
      initialRefreshInterval={dashboardResource.spec.refreshInterval ?? "0s"}
    >
      <VariableProvider
        key={dashboardResource.metadata.name}
        builtinVariableDefinitions={builtinVariables}
        initialVariableDefinitions={dashboardResource.spec.variables}
      >
        <PanelFocusProvider>
          <DatasourceStoreProvider
            dashboardResource={dashboardResource}
            datasourceApi={datasourceApi}
          >
            <DataQueriesProvider definitions={[]}>
              <DashboardProvider initialState={{ dashboardResource }}>
                <ValidationProvider>{children}</ValidationProvider>
              </DashboardProvider>
            </DataQueriesProvider>
          </DatasourceStoreProvider>
        </PanelFocusProvider>
      </VariableProvider>
    </TimeRangeProviderBasic>
  );
}
