// React-18 island entry for rendering perses dashboards. Next 16 forces react 19
// into its client bundles, but perses 0.55 (and its module-federation plugin
// bundles) require react ^18.3, so this standalone bundle is built with the real
// react 18.3.1 and mounted via react-dom 18 createRoot into a div the host page
// provides. Built by perses-island/build.mjs into public/perses-viewer/.

import { CacheProvider } from "@emotion/react";
import createCache from "@emotion/cache";
import * as EmotionStyled from "@emotion/styled";
// Initialize echarts eagerly. @perses-dev/components' EChart imports `init` and
// `use` from echarts, but esbuild's handling of the components <-> EChart cycle
// does not run the echarts module init before the component mounts, leaving
// echarts' internal registries undefined ("Cannot read properties of undefined
// (reading 'null')" from getInstanceByDom). Importing the echarts entry (listed
// in its sideEffects) runs the core init at bundle load.
import "echarts";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { DashboardResource } from "@perses-dev/client";

import "@/lib/perses/config";
import { DashboardViewer } from "../components/perses/DashboardViewer";

// Plugin bundles consume the host's shared modules through webpack's interop
// helper, which only picks `default` when the shared module is flagged as an ES
// module. esbuild's namespace objects (handed over by plugin-system's
// `lib: () => EmotionStyled`) carry no `__esModule`, so a plugin doing
// `import styled from '@emotion/styled'` receives the whole namespace and
// throws "o(...) is not a function". Flag the namespace to restore the
// webpack-built behaviour.
Object.defineProperty(EmotionStyled, "__esModule", { value: true });

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
