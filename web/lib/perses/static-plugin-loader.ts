// Static plugin loader: the dashboard's plugins are bundled with the portal
// instead of being fetched from the Perses server at runtime.
//
// The alternative (perses' remotePluginLoader) asks GET /api/v1/plugins which
// modules the server has installed and loads each one as a module-federation
// remote. That keeps plugins upgradeable without rebuilding the portal, but it
// costs the client a registry round trip and a fan-out of chunk requests:
// measured 42 after trimming to the dashboard's plugins, ~114 with the stock
// plugin set, and ~3 MB that the proxy re-downloaded on every visit because
// Perses serves plugin assets with `no-cache`.
//
// Bundling inverts the trade. Each plugin is an npm dependency, so the bundler
// includes it and dedupes its React/MUI/echarts against the copies the island
// already ships: the whole set costs +0.16 MB gzipped, and a warm load drops to
// ~100 KB (API calls only) because everything comes from the static cache.
// The cost is that the plugin set is fixed at build time — adding or upgrading
// a plugin now means rebuilding the portal image.
//
// Each package exports `getPluginModule()` (its `perses` metadata from
// package.json) plus the plugin implementations themselves. PluginRegistry
// resolves an implementation by plugin name, which is exactly the package
// namespace, so the namespace doubles as the module's plugin map.

import * as PrometheusPlugin from "@perses-dev/prometheus-plugin";
import * as TimeSeriesChartPlugin from "@perses-dev/timeseries-chart-plugin";
import type { PluginLoader, PluginModuleResource } from "@perses-dev/plugin-system";
import { dynamicImportPluginLoader } from "@perses-dev/plugin-system";

/** A plugin npm package: its resource metadata plus the exported plugins. */
interface BundledPluginPackage {
  getPluginModule(): PluginModuleResource;
}

// The dashboards under assets/observability/dashboards/perses use exactly
// these two modules: Prometheus (datasource, query, label-values variable) and
// TimeSeriesChart (every panel). Adding a panel that renders a new plugin kind
// means adding its package here as well — the loader only hands the registry
// what is listed, so an omitted module simply fails to resolve at runtime.
const BUNDLED_PLUGINS = [
  PrometheusPlugin,
  TimeSeriesChartPlugin,
] as unknown as BundledPluginPackage[];

/** A plugin loader backed by the portal's own bundle. */
export function createStaticPluginLoader(): PluginLoader {
  return dynamicImportPluginLoader(
    BUNDLED_PLUGINS.map((module) => ({
      resource: module.getPluginModule(),
      importPlugin: () => Promise.resolve(module),
    })),
  );
}
