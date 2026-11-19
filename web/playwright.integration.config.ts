import { defineConfig } from "@playwright/test";

// Suite C — the cross-repo integration suite. Unlike Suite A (browser-level
// stubs) it runs against a REAL cubepilot stack on KinD and the portal built
// from this working tree, both in namespace cubestack-system. Nothing is
// stubbed: the portal's own Next routes proxy to cubepilot-api and read the
// agent/task CRs from the cluster.
//
// Requirements (not CI-cheap; local or CI bring-up first):
//   - bash e2e/deploy/integration/setup.sh
//   - a kubeconfig pointing at the e2e cluster (the webServer port-forwards)
export default defineConfig({
  testDir: "./e2e",
  testMatch: /\.integration\.spec\.ts$/,
  // The suite drives one shared cluster: serial keeps CR assertions readable
  // and avoids two specs mutating the same AgentInstance at once.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // A real model is in the loop for the chat suite; one retry absorbs its noise.
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:8080",
    trace: "on-first-retry",
  },
  webServer: {
    // The portal already runs in the cluster; Playwright only needs the
    // port-forward, so it is the command rather than another script file.
    command: "kubectl -n cubestack-system port-forward svc/portal 8080:80",
    // The readiness probe must hit the app's base path — a bare "/" 404s.
    url: "http://localhost:8080/cubestack",
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
});
