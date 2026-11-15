import type { ReactNode } from "react";

import { withBasePath } from "@/lib/base-path";

// Preload the perses island bundle.
//
// The bundle is 3.2 MB compressed and PersesIslandHost injects it with
// document.createElement("script") from a useEffect — i.e. only after Next has
// hydrated and the dashboard resource has been fetched. Measured on the
// dashboard route, that request only started ~1.2 s into the load while the
// page sat waiting for hydration; preloading from the document head lets the
// download overlap that wait instead.
//
// The island is loaded by every page below /dashboards (the landing mounts a
// viewer too), so this layout is the narrowest place that covers all of them.
const ISLAND_JS = withBasePath("/perses-viewer/perses-viewer.js");
const ISLAND_CSS = withBasePath("/perses-viewer/perses-viewer.css");

export default function DashboardsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <link rel="preload" as="script" href={ISLAND_JS} />
      <link rel="preload" as="style" href={ISLAND_CSS} />
      {children}
    </>
  );
}
