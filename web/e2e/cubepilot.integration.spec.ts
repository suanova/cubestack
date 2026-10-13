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

test.describe("agent config writes the AgentInstance CR", () => {
  test.beforeEach(async ({ context, page }) => {
    // Headless Chromium reports en-US, so the platform locale would fall back to
    // English and the Chinese toast asserted below would never match. Every other
    // suite pins zh-CN for the same reason.
    await page.addInitScript(() => localStorage.setItem("cubestack-locale", "zh-CN"));
    await seedSession(context);
  });

  test("the model picker is populated from the builtin template in the cluster", async ({ page }) => {
    await page.goto(`${BASE}/cubepilot`);
    await page.locator('[data-od-id="cp-tab-config"]').click();
    await expect(page.locator('[data-od-id="cp-config-pane"]')).toBeVisible();
    // The operator's builtin AgentTemplate declares one provider (the model the
    // bring-up configured), so the picker must not be empty. An unreachable
    // cluster would leave it empty.
    await expect(page.locator('[data-od-id="cp-config-model-select"] option')).not.toHaveCount(0);
  });

  test("saving the system prompt writes it to the AgentInstance CR", async ({ page, context }) => {
    const marker = process.env.E2E_MARKER ?? "";
    expect(marker, "E2E_MARKER must be exported by setup.sh / the workflow").not.toBe("");

    await page.goto(`${BASE}/cubepilot`);
    await page.locator('[data-od-id="cp-tab-config"]').click();
    // Let the card's first read land before typing: the prompt field is bound to
    // it, so a fill typed into the not-yet-loaded form is what the late read
    // overwrites.
    await expect(page.locator('[data-od-id="cp-config-model-select"] option')).not.toHaveCount(0);
    await page.locator('[data-od-id="cp-config-prompt-input"]').fill(`集成测试标记 ${marker}`);
    await page.locator('[data-od-id="cp-config-save"]').click();
    // Either toast means the save went through: the bring-up's warm-up already
    // provisioned admin-cubepilot, but a cluster without it turns this save into a
    // create, and the pane words that differently.
    await expect(page.getByText(/已保存/)).toBeVisible();

    // Read it back through the portal's own route, which reads the CR from the
    // cluster — a UI-only memory of the edit would not survive this.
    // context.request (not the standalone `request` fixture) shares the browser
    // context's cookie jar, so the seeded session reaches withAuth.
    const cfg = await context.request.get(`${BASE}/api/cubepilot/agent/config`);
    expect(cfg.status()).toBe(200);
    const body = (await cfg.json()) as { config?: { userInstructions?: string } };
    expect(body.config?.userInstructions ?? "").toContain(marker);
  });
});

test.describe("tasks tab reads real Task CRs", () => {
  test.beforeEach(async ({ context, page }) => {
    // This describe asserts Chinese copy, so it needs the same locale pin the
    // rest of the suite uses (headless Chromium reports en-US).
    await page.addInitScript(() => localStorage.setItem("cubestack-locale", "zh-CN"));
    await seedSession(context);
  });

  const openTasks = async (page: import("@playwright/test").Page) => {
    await page.goto(`${BASE}/cubepilot`);
    await page.locator('[data-od-id="cp-tab-tasks"]').click();
    await expect(page.locator('[data-od-id="cp-tasks-pane"]')).toBeVisible();
  };

  test("the seeded Task CR is rendered as a row", async ({ page }) => {
    const marker = process.env.E2E_MARKER ?? "";
    expect(marker, "E2E_MARKER must be exported by setup.sh / the workflow").not.toBe("");
    await openTasks(page);

    // Located by the seeded display name, not by row id: the projection's id
    // derivation is not part of what this test is about.
    await expect(
      page.locator('[data-od-id^="cp-task-row-"]').filter({ hasText: marker }),
    ).toBeVisible();
    // The empty state must be gone, which is the observable difference between
    // "the CR reached the page" and "the page rendered nothing".
    await expect(page.locator('[data-od-id="cp-tasks-pane"]')).not.toContainText("暂无任务");
  });

  test("the task templates segment lists the operator's presets", async ({ page }) => {
    await openTasks(page);
    await page.locator('[data-od-id="cp-tasks-seg-templates"]').click();
    // The operator publishes the preset display names in English, so the zh-CN
    // page renders that string verbatim (the CR's spec.displayName).
    await expect(page.locator('[data-od-id="cp-tasks-templates"]')).toContainText("Daily Cluster Inspection");
  });
});
