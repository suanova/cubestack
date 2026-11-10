// Perses plugin-system expects a few browser globals that the reference app
// injects at build time (webpack DefinePlugin). Set them here at module load.
// They're only read by our own wrapper components, but keeping the same names
// lets us port the provider chain verbatim.

import { withBasePath } from "../base-path";

// Carries the deployment base path: this string reaches the browser both as a
// fetch target here and baked into the perses island bundle (perses-island/
// build.mjs runs off this file), and neither goes through Next's Link/router
// rewriting.
export const PERSES_PROXY_BASE_PATH = withBasePath("/api/perses");

// Project the provisioned dashboards live in on the Perses server. This is
// the build-time default baked into the client bundle; the deployment's
// actual project comes from the PERSES_PROJECT env var (helm: env.PERSES_PROJECT)
// and is applied server-side — the /api/perses proxy substitutes it into the
// request path, so changing projects never requires a rebuild. Must match the
// namespace the PersesDashboard CRs live in (namespace = project).
export const PERSES_PROJECT = process.env.NEXT_PUBLIC_PERSES_PROJECT ?? "monitoring";

// The dashboard the monitoring landing opens on when the URL does not name one.
// Named here rather than in the landing alone: the Overview KPI cards deep-link
// to this same dashboard by name, and two spellings of "the platform's own
// resource overview" is how a landing ends up opening on whichever dashboard
// happens to sort first (measured on a real install: metax-gpu).
export const DEFAULT_DASHBOARD_NAME = "resource-overview-dashboard";

declare global {
  interface Window {
    PERSES_APP_CONFIG?: { api_prefix: string };
    PERSES_PLUGIN_ASSETS_PATH?: string;
  }
}

// Note: the perses remote plugin bundles register `react`/`react-dom` as
// module-federation singletons. Their manifests pin the exact requiredVersion
// "18.2.0" (a stale pin from the plugins' package.json — the bundles
// themselves are built with 18.3.1), while perses 0.55's own packages require
// react ^18.3.0. No single version satisfies both, so federation logs a
// version warning per plugin. With strictVersion disabled it still hands the
// plugin the host's 18.3.1 copy, so the warning is cosmetic.
if (typeof window !== "undefined") {
  window.PERSES_APP_CONFIG = { api_prefix: PERSES_PROXY_BASE_PATH };
  window.PERSES_PLUGIN_ASSETS_PATH = PERSES_PROXY_BASE_PATH;
}
