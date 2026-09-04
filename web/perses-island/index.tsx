// React-18 island entry for rendering perses dashboards. Next 16 forces react 19
// into its client bundles, but perses 0.54 (and its module-federation plugin
// bundles) require react ^18, so this standalone bundle is built with the real
// react 18.2.0 and mounted via react-dom 18 createRoot into a div the host page
// provides. Built by perses-island/build.mjs into public/perses-viewer/.

import { CacheProvider } from "@emotion/react";
import createCache from "@emotion/cache";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { DashboardResource } from "@perses-dev/core";

import "@/lib/perses/config";
import { DashboardViewer } from "../components/perses/DashboardViewer";

// The host page already runs its own emotion (cache key "css") under react 19.
// Give the island a distinct cache key so a host-side flush can't purge the
// island's styles.
const islandCache = createCache({ key: "perses-island" });

export interface PersesIslandOptions {
  project: string;
  dashboardName: string;
  dashboardResource: DashboardResource;
  variableRowSpacing?: string;
  scope?: string;
}

export function mountPersesIsland(
  el: HTMLElement,
  options: PersesIslandOptions,
): () => void {
  // el is empty, so render() not hydrateRoot().
  const root: Root = createRoot(el);
  root.render(
    <CacheProvider value={islandCache}>
      <DashboardViewer
        project={options.project}
        dashboardName={options.dashboardName}
        dashboardResource={options.dashboardResource}
        variableRowSpacing={options.variableRowSpacing}
        scope={options.scope}
      />
    </CacheProvider>,
  );
  return () => root.unmount();
}
