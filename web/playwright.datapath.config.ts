import { defineConfig } from "@playwright/test";

// Suite B — a single smoke spec that exercises the *real* /api/overview route
// against the preview stack: mock Prometheus + perses proxy + Next, with the
// live KinD cluster supplying the node/CR figures. This is the only place the
// PromQL parse -> padSeries(48) -> chart path is verified end to end.
//
// Requirements (not CI-cheap; run locally):
//   - the KinD cluster reachable via the default kubeconfig
//   - run-preview.sh: downloads the perses binary on first use and starts
//     mock-prometheus (:9090) + perses (:8081) + Next (:3000)
export default defineConfig({
  testDir: "./e2e",
  testMatch: /\.datapath\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "bash e2e/deploy/perses/local/run-preview.sh",
    url: "http://localhost:3000",
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
