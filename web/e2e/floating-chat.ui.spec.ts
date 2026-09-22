import { expect, test, type Page } from "@playwright/test";

import { overviewSummary } from "../test/fixtures/overview";
import { seedSession } from "./auth";

// Deterministic e2e for the global floating AI chat (FloatingChat): the
// bottom-right launcher that is served on every portal page EXCEPT the
// 智能助手 chat tab (that tab IS the conversation), and the compact panel it
// opens — the same CubePilot conversation the chat tab owns (one fixed
// session key), streamed through the pilot proxy.
//
// Every /api/cubepilot/* endpoint the surface hits is stubbed at the network
// level, like the cubepilot.ui suite, so no KinD cluster, cubepilot-api or AI
// Gateway is required. The platform locale is pinned to zh-CN.

const SESSION_KEY = "agent:main:conv-portal";

const STATUS_READY = {
  exists: true,
  id: "admin-cubepilot",
  phase: "Ready",
  uptimeSeconds: 7200,
  user: "admin",
  podName: "cubepilot-admin-7d9f",
  pvcName: "pvc-admin-cubepilot",
};

const CONFIG_READY = {
  exists: true,
  selectedModel: "cubestack/qwen38-27b",
  userInstructions: "",
};

const SKILLS = {
  skills: [
    { name: "cluster-inspect", displayName: "集群巡检", description: "节点与 Pod 巡检", enabled: true },
    { name: "gpu-health", displayName: "GPU 体检", description: "GPU 温度与 ECC", enabled: true },
  ],
};

const CONFIRM = {
  exists: true,
  confirmPolicy: "Allowlist",
  templatePolicy: "Allowlist",
  override: "",
  allowlist: [],
  channel: "unknown",
};

/** A turn that answers and finishes cleanly (terminal on the stream). */
const TURN_DONE = [
  { type: "message_start", sessionId: SESSION_KEY },
  { type: "agent_thinking", sessionId: SESSION_KEY },
  { type: "message_delta", sessionId: SESSION_KEY, delta: "集群状态良好。" },
  { type: "message_delta", sessionId: SESSION_KEY, delta: "所有节点 Ready。" },
  { type: "message_done", sessionId: SESSION_KEY },
];

/** A turn that runs a tool, then parks on a write approval.
 *
 *  It carries NO terminal: a turn waiting on a human has not ended. The stub
 *  cannot hold a stream open, so the body simply ends and the client reports
 *  the stream as lost; either way the card stays answerable, which is what
 *  this spec is about. */
const TURN_APPROVAL = [
  { type: "message_start", sessionId: SESSION_KEY },
  { type: "agent_thinking", sessionId: SESSION_KEY },
  { type: "message_delta", sessionId: SESSION_KEY, delta: "正在检查 Ceph 状态…" },
  { type: "tool_call", sessionId: SESSION_KEY, callId: "call-1", name: "shell", arguments: { cmd: "ceph df" } },
  { type: "tool_result", sessionId: SESSION_KEY, callId: "call-1", name: "shell", output: "POOL USED: 71%" },
  { type: "message_delta", sessionId: SESSION_KEY, delta: "OSD 使用率 71%。" },
  {
    type: "approval_pending",
    sessionId: SESSION_KEY,
    callId: "app-1",
    name: "shell",
    command: "ceph osd set-noscrub",
    level: "write",
    message: "调整 OSD 参数属于写操作",
  },
];

function sseBody(events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

interface Captured {
  messagePosts: Array<{ path: string; body: { content?: string; sessionId?: string } }>;
}

/** Stub the endpoints the surface touches (plus /api/overview so a test that
 *  visits the landing page stays healthy). */
async function stubFloatingChat(page: Page, turnEvents: object[]): Promise<Captured> {
  const captured: Captured = { messagePosts: [] };
  await page.route("**/api/overview", (route) => route.fulfill({ json: overviewSummary() }));
  await page.route("**/api/cubepilot/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const post = () => JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;

    // The other /cubepilot tabs mount their panes too: keep them quiet.
    if (path.endsWith("/api/cubepilot/tasks")) return json({ tasks: [], reports: [] });
    if (path.endsWith("/api/cubepilot/tasktemplates")) return json({ taskTemplates: [] });
    if (path.endsWith("/api/cubepilot/agent/status")) return json(STATUS_READY);
    if (path.endsWith("/api/cubepilot/agent/config")) return json({ config: CONFIG_READY });
    if (path.endsWith("/api/cubepilot/agent/confirm")) return json(CONFIRM);
    if (path.endsWith("/api/cubepilot/skills")) return json(SKILLS);
    if (path.endsWith("/api/cubepilot/playground/services"))
      return json({ models: [{ id: "qwen38-27b", ownedBy: "cubestack" }], endpoint: "http://ai-gateway.test:8080" });

    if (path.includes("/api/cubepilot/pilot/")) {
      if (path.endsWith("/approval/pending")) return json({ error: "no pending approval" }, 404);
      if (path.endsWith("/question/pending")) return json({ error: "no pending question" }, 404);
      if (path.endsWith("/messages")) {
        if (method === "POST") {
          captured.messagePosts.push({ path, body: post() as { content?: string; sessionId?: string } });
          return route.fulfill({
            status: 200,
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
            body: sseBody(turnEvents),
          });
        }
        return json({ error: "no such session" }, 404);
      }
      if (path.endsWith("/turn")) return json({ active: false });
      if (path.endsWith("/approval") && method === "POST") {
        const body = post();
        return json({ approved: body.decision !== "reject", decision: body.decision, approvalId: body.approvalId });
      }
      if (path.endsWith("/abort") && method === "POST") return json({ ok: true });
    }
    return json({ error: `unstubbed ${method} ${path}` }, 404);
  });
  return captured;
}

test.beforeEach(async ({ context, page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("cubestack-locale", "zh-CN");
    localStorage.setItem("cubestack-theme", "light");
  });
  await seedSession(context);
});

test.describe("global floating AI chat", () => {
  test("sits in the bottom-right corner of a portal page, closed", async ({ page }) => {
    await stubFloatingChat(page, TURN_DONE);
    await page.goto("/");

    const fab = page.locator('[data-od-id="fchat-fab"]');
    await expect(fab).toBeVisible();
    await expect(fab).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator('[data-od-id="fchat-panel"]')).toHaveCount(0);

    // Bottom-right of the viewport: 20px from the right and bottom edges.
    const box = await fab.boundingBox();
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    expect(box).not.toBeNull();
    expect(Math.abs(box!.x + box!.width - (viewport.width - 20))).toBeLessThan(2);
    expect(Math.abs(box!.y + box!.height - (viewport.height - 20))).toBeLessThan(2);
  });

  test("is absent on the 智能助手 chat tab — that tab IS the conversation", async ({ page }) => {
    await stubFloatingChat(page, TURN_DONE);
    // Default tab is chat.
    await page.goto("/cubepilot");

    await expect(page.locator('[data-od-id="fchat-fab"]')).toHaveCount(0);
    // The full pane is what is there instead.
    await expect(page.locator('[data-od-id="pane-chat"]')).toBeVisible();
  });

  test("is present on the 智能助手 tabs that have no chat of their own", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("cubestack.cubepilot.tab", "tasks");
    });
    await stubFloatingChat(page, TURN_DONE);
    await page.goto("/cubepilot");

    await expect(page.locator('[data-od-id="cp-tab-tasks"]')).toHaveAttribute("aria-selected", "true");
    const fab = page.locator('[data-od-id="fchat-fab"]');
    await expect(fab).toBeVisible();

    // …and switching back to the chat tab removes it again.
    await page.click('[data-od-id="cp-tab-chat"]');
    await expect(fab).toHaveCount(0);
  });

  test("opens the panel, greets from real data, and streams a turn to its end", async ({ page }) => {
    const captured = await stubFloatingChat(page, TURN_DONE);
    await page.goto("/");

    await page.click('[data-od-id="fchat-fab"]');
    const panel = page.locator('[data-od-id="fchat-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("aria-label", "CubeStack AI 智算 Copilot");

    // The greeting is data-driven (skills from the CRs, model from the CR).
    await expect(panel).toContainText("技能 2 项");
    await expect(panel).toContainText("当前模型 qwen38-27b");
    // The mockup's quick prompts, offered while the conversation is fresh.
    await expect(panel.locator('[data-od-id="fchat-quick"]')).toHaveCount(1);

    await panel.locator('[data-od-id="fchat-input"]').fill("集群状态如何?");
    await panel.locator('[data-od-id="fchat-send"]').click();

    // The real SSE reply streams in and the turn settles on its terminal.
    await expect(panel).toContainText("所有节点 Ready。");
    await expect(panel.locator('[data-od-id="fchat-status"]')).toContainText("已完成");
    // The conversation is no longer fresh: the quick prompts are gone.
    await expect(panel.locator('[data-od-id="fchat-quick"]')).toHaveCount(0);

    // The send named the ONE fixed conversation the chat tab owns.
    await expect
      .poll(() => captured.messagePosts.length)
      .toBe(1);
    expect(captured.messagePosts[0].body.sessionId).toBe(SESSION_KEY);
    expect(captured.messagePosts[0].body.content).toBe("集群状态如何?");
  });

  test("parks on the approval card its turn raises, and answers it", async ({ page }) => {
    await stubFloatingChat(page, TURN_APPROVAL);
    await page.goto("/");

    await page.click('[data-od-id="fchat-fab"]');
    const panel = page.locator('[data-od-id="fchat-panel"]');
    await expect(panel).toBeVisible();

    await panel.locator('[data-od-id="fchat-input"]').fill("分析 Ceph OSD 使用率告警");
    await panel.locator('[data-od-id="fchat-send"]').click();

    // The write is parked: its card docks above the composer, with the
    // decision buttons (Allowlist policy offers the durable rule too).
    await expect(panel.locator('[data-od-id="hitl-dock"]')).toBeVisible();
    await expect(panel).toContainText("写操作待审批");
    await expect(panel).toContainText("ceph osd set-noscrub");
    await expect(panel.locator('[data-od-id="approval-allow"]')).toBeVisible();

    await panel.locator('[data-od-id="approval-approve"]').click();
    await expect(panel).toContainText("已批准");
    await expect(panel.locator('[data-od-id="approval-approve"]')).toHaveCount(0);
  });

  test("closes from its own close button", async ({ page }) => {
    await stubFloatingChat(page, TURN_DONE);
    await page.goto("/");

    const fab = page.locator('[data-od-id="fchat-fab"]');
    await fab.click();
    await expect(page.locator('[data-od-id="fchat-panel"]')).toBeVisible();
    await expect(fab).toHaveAttribute("aria-expanded", "true");

    await page.click('[data-od-id="fchat-close"]');
    await expect(page.locator('[data-od-id="fchat-panel"]')).toHaveCount(0);
    await expect(fab).toHaveAttribute("aria-expanded", "false");
    // One click re-opens the same surface.
    await fab.click();
    await expect(page.locator('[data-od-id="fchat-panel"]')).toBeVisible();
  });
});
