import { expect, test } from "@playwright/test";

import { seedSession } from "./auth";

const BASE = "/cubestack";

// The conversational layer drives a real model: it only runs when the bring-up
// had a real provider key. Everything else in the suite is deterministic.
const CHAT_ENABLED = process.env.CUBEPILOT_E2E_CHAT === "1";

test.describe("cubepilot chat against the real backend", () => {
  test.skip(!CHAT_ENABLED, "set CUBEPILOT_E2E_CHAT=1 with a real CUBEPILOT_LLM_APIKEY");

  // The waits below budget a real model (240s + 180s + 180s in the heaviest
  // test), but the config's `timeout` is the webServer's and the framework
  // default is 30s, under which none of them could ever elapse.
  test.describe.configure({ timeout: 720_000 });

  test.beforeEach(async ({ context }) => {
    await seedSession(context);
  });

  // The prompts mirror cubepilot's own e2e (test/e2e/cubestack_chat_test.go and
  // hitl_chat_test.go): the first asks for a write the Allowlist policy parks,
  // which is what raises the approval card in the portal.
  const WRITE_PROMPT =
    "帮我创建一个开发机:名字叫 dev-portal-e2e,放在 default 命名空间,1 核 CPU、2Gi 内存," +
    "镜像用 pytorch/pytorch:2.3.1-cuda12.1-cudnn8-runtime。";

  const openChat = async (page: import("@playwright/test").Page) => {
    await page.goto(`${BASE}/cubepilot`);
    await page.locator('[data-od-id="cp-tab-chat"]').click();
    await expect(page.locator('[data-od-id="chat-thread"]')).toBeVisible();
  };

  test("a turn streams a reply into the transcript", async ({ page }) => {
    await openChat(page);
    await page.locator('[data-od-id="chat-input"]').fill("用一句话打招呼。");
    await page.locator('[data-od-id="send-btn"]').click();
    // The bubble draws from the turn's start — its CUBEPILOT label and a
    // thinking line precede any content — so visibility alone would pass
    // against a dead backend. Require a text block, then a clean end.
    await expect(page.locator('[data-od-block="text"]').first()).toBeVisible({ timeout: 180_000 });
    await expect(page.locator('[data-od-id="stop-btn"]')).toHaveCount(0, { timeout: 180_000 });
    await expect(page.locator('[data-od-id="agent-error"]')).toHaveCount(0);
    await expect(page.locator('[data-od-id="agent-lost"]')).toHaveCount(0);
    await expect(page.locator('[data-od-id="agent-stopped"]')).toHaveCount(0);
  });

  test("a write parks on an approval card, and approving lets the turn finish", async ({ page }) => {
    await openChat(page);
    await page.locator('[data-od-id="chat-input"]').fill(WRITE_PROMPT);
    await page.locator('[data-od-id="send-btn"]').click();

    const card = page.locator('[data-od-id="approval-item"]').first();
    await expect(card).toBeVisible({ timeout: 240_000 });
    await page.locator('[data-od-id="approval-approve"]').first().click();

    // The decision reaches cubepilot-api and the turn is no longer parked.
    await expect(page.locator('[data-od-id="approval-item"]')).toHaveCount(0, { timeout: 180_000 });
    await expect(page.locator('[data-od-id="stop-btn"]')).toHaveCount(0, { timeout: 180_000 });
  });

  test("a reload restores the conversation", async ({ page }) => {
    const marker = process.env.E2E_MARKER ?? "";
    expect(marker, "E2E_MARKER must be exported by setup.sh / the workflow").not.toBe("");

    await openChat(page);
    await page.locator('[data-od-id="chat-input"]').fill(`用一句话记住:集成测试标记 ${marker}。`);
    await page.locator('[data-od-id="send-btn"]').click();
    await expect(page.locator('[data-od-id="agent-bubble"]').first()).toBeVisible({ timeout: 180_000 });

    await page.reload();
    // History comes from cubepilot-api through the proxy, not from memory. The
    // marker pins the restored thread to THIS turn: the pane's session key is
    // fixed, so a bare bubble assertion is satisfied by the earlier tests.
    await expect(page.locator('[data-od-id="chat-thread"]')).toContainText(marker, { timeout: 60_000 });
  });
});
