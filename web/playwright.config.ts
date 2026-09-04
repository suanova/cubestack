import { defineConfig } from "@playwright/test";

// Suite A — the primary, CI-cheap e2e suite. It runs against a plain Next dev
// server and intercepts /api/overview at the network level (see
// e2e/overview.ui.spec.ts), so no KinD cluster or Prometheus is required.
//
// The trend data-path smoke test lives in playwright.datapath.config.ts and
// must be run separately (it needs the cluster + preview stack).
export default defineConfig({
  testDir: "./e2e",
  testMatch: /\.ui\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      // Fixed signing key so the specs can mint session cookies the auth
      // proxy/guard will accept (see e2e/auth.ts). Keep in sync there.
      SESSION_SECRET: "e2e-session-secret",
    },
  },
});
