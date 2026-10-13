import { expect, test } from "@playwright/test";

import { seedSession } from "./auth";

const BASE = "/cubestack";

// The conversational layer drives a real model: it only runs when the bring-up
// had a real provider key. Everything else in the suite is deterministic.
const CHAT_ENABLED = process.env.CUBEPILOT_E2E_CHAT === "1";

test.describe("cubepilot chat against the real backend", () => {
  test.skip(!CHAT_ENABLED, "set CUBEPILOT_E2E_CHAT=1 with a real CUBEPILOT_LLM_APIKEY");

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
    await expect(page.locator('[data-od-id="agent-bubble"]').first()).toBeVisible({ timeout: 180_000 });
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
    await openChat(page);
    await page.locator('[data-od-id="chat-input"]').fill("用一句话记住:集成测试标记。");
    await page.locator('[data-od-id="send-btn"]').click();
    await expect(page.locator('[data-od-id="agent-bubble"]').first()).toBeVisible({ timeout: 180_000 });

    await page.reload();
    // History comes from cubepilot-api through the proxy, not from memory.
    await expect(page.locator('[data-od-id="agent-bubble"]').first()).toBeVisible({ timeout: 60_000 });
  });
});
