import { expect, test } from "@playwright/test";

import { seedSession } from "./auth";

// The portal is served under a sub-path (web/base-path.mjs).
const BASE = "/cubestack";

// The proxy answers these when the backend is not wired, so their absence is
// what "the request reached cubepilot-api" actually means here.
const UNREACHABLE = "agent API unreachable";
const NO_BASE = "CubePilot agent API not found";

test.describe("portal → cubepilot boundary (real backend)", () => {
  test.beforeEach(async ({ context }) => {
    await seedSession(context);
  });

  test("the portal is served from the cluster and our signed cookie is accepted", async ({ page }) => {
    await page.goto(`${BASE}/cubepilot`);
    await expect(page.locator('[data-od-id="cp-tab-chat"]')).toBeVisible();
  });

  // context.request (not the standalone `request` fixture) shares the browser
  // context's cookie jar, so the session seeded in beforeEach reaches withAuth;
  // the isolated `request` fixture sends no cookies and the routes answer 401.
  test("a path outside the proxy allow-list is refused with 404", async ({ context }) => {
    // /transcript is not in lib/cubepilot/pilotpath.ts's allow-list.
    const res = await context.request.get(`${BASE}/api/cubepilot/pilot/api/v1/sessions/any/transcript`);
    expect(res.status()).toBe(404);
  });

  test("an allow-listed path reaches the real cubepilot-api", async ({ context }) => {
    const res = await context.request.get(`${BASE}/api/cubepilot/pilot/api/v1/sessions`);
    const body = await res.text();
    expect(body, `proxy could not reach the API: ${body}`).not.toContain(UNREACHABLE);
    expect(body, `agent API base URL not resolved: ${body}`).not.toContain(NO_BASE);
    expect(res.status(), `unexpected status ${res.status()}: ${body}`).toBe(200);
  });
});
