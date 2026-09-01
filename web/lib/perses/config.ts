// Perses plugin-system expects a few browser globals that the reference app
// injects at build time (webpack DefinePlugin). Set them here at module load.
// They're only read by our own wrapper components, but keeping the same names
// lets us port the provider chain verbatim.

export const PERSES_PROXY_BASE_PATH = "/api/perses";

// Project the provisioned dashboards live in on the Perses server. Overridable
// at build time; must match e2e/deploy/perses/provisioning/project.yaml.
export const PERSES_PROJECT = process.env.NEXT_PUBLIC_PERSES_PROJECT ?? "perses-dev";

declare global {
  interface Window {
    PERSES_APP_CONFIG?: { api_prefix: string };
    PERSES_PLUGIN_ASSETS_PATH?: string;
  }
}

// Note: the perses remote plugin bundles register `react`/`react-dom` as
// module-federation singletons pinned to the exact React they were built with
// (18.2.0). Our host React is 18.3.1, so federation rejects the share and each
// remote loads its own React copy. That is logged as a warning per plugin but
// is harmless — the dashboards render correctly with it.
if (typeof window !== "undefined") {
  window.PERSES_APP_CONFIG = { api_prefix: PERSES_PROXY_BASE_PATH };
  window.PERSES_PLUGIN_ASSETS_PATH = PERSES_PROXY_BASE_PATH;
}
