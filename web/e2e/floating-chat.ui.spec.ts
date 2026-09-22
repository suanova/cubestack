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

/** The computed view-transition name of an element. The morph's two ends carry
 *  the same one and nothing else does, so this is how the wiring is asserted —
 *  the animation itself is the browser's and is not observable from a test. */
const vtName = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => getComputedStyle(el).viewTransitionName);

function sseBody(events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

interface Captured {
  messagePosts: Array<{ path: string; body: { content?: string; sessionId?: string } }>;
}

/** Stub the endpoints the surface touches (plus /api/overview so a test that
 *  visits the landing page stays healthy).
 *
 *  `historyOnce` answers the FIRST transcript read with those items and every
 *  later one with the runtime's "this conversation has not started". That is how
 *  the handoff is provable: whichever surface reads second cannot supply the
 *  thread, so a thread on screen came from the handoff.
 *
 *  `staleHistory` is served for every read once the test calls `serveStale()`.
 *  That flip is what makes the case deterministic: reads before it (the widget's
 *  restore and its follow tick) carry the thread, and the reads after it — the
 *  pane's own restore, and the follow loop's — carry an older copy. */
async function stubFloatingChat(
  page: Page,
  turnEvents: object[],
  stubs: { historyOnce?: object[]; staleHistory?: object[] } = {},
): Promise<Captured & { serveStale: () => void }> {
  const captured: Captured = { messagePosts: [] };
  let historyReads = 0;
  let stale = false;
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
      // The send and the transcript read are the SAME path, so the method is
      // what tells them apart — matched first, or the 404 below would answer
      // the send.
      if (path.endsWith("/messages")) {
        if (method === "POST") {
          captured.messagePosts.push({ path, body: post() as { content?: string } });
          return route.fulfill({
            status: 200,
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
            body: sseBody(turnEvents),
          });
        }
        if (stale && stubs.staleHistory) return json({ items: stubs.staleHistory });
        if (stubs.historyOnce && ++historyReads === 1) return json({ items: stubs.historyOnce });
        return json({ error: "no such session" }, 404);
      }
      // The pending collections: an empty one is the ordinary "nothing is
      // parked".
      if (path.endsWith("/approvals")) return json({ approvals: [] });
      if (path.endsWith("/questions")) return json({ questions: [] });
      if (path.endsWith("/turn")) return json({ active: false });
      if (path.endsWith("/approvals/decision") && method === "POST") {
        const body = post();
        return json({ approved: body.decision !== "reject", decision: body.decision, approvalId: body.approvalId });
      }
      if (path.endsWith("/questions/answer")) return json({ questionId: "q-1", cancelled: false });
      if (path.endsWith("/questions/cancel")) return json({ questionId: "q-1", cancelled: true });
      if (path.endsWith("/abort") && method === "POST") return json({ ok: true });
    }
    return json({ error: `unstubbed ${method} ${path}` }, 404);
  });
  return { ...captured, serveStale: () => { stale = true; } };
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

  test("expanding hands the conversation over, so the pane paints it before its own restore lands", async ({ page }) => {
    // Both surfaces drive the same session, so the pane would restore the same
    // thread by itself — but only behind a metadata read and a history read, and
    // until those land a reader who just expanded a conversation sees a greeting,
    // which reads as "it is gone" rather than "it got bigger".
    //
    // The stub makes that provable: only the FIRST transcript read answers (the
    // widget's). Every later one is the runtime's "this conversation has not
    // started", so a thread on screen after the expansion can only be the one the
    // widget handed over.
    await stubFloatingChat(page, TURN_DONE, {
      historyOnce: [
        { role: "user", content: "上次巡检的结论?" },
        { role: "assistant", content: [{ type: "text", text: "2 个节点 NotReady,已在 09:20 恢复。" }] },
      ],
    });
    await page.goto("/");
    await page.click('[data-od-id="fchat-fab"]');
    await expect(page.locator('[data-od-id="fchat-panel"]')).toContainText("上次巡检的结论?");

    await page.click('[data-od-id="fchat-expand"]');

    // The full pane, on the chat tab, holding the same conversation.
    await expect(page).toHaveURL(/\/cubepilot/);
    await expect(page.locator('[data-od-id="pane-chat"]')).toBeVisible();
    await expect(page.locator('[data-od-id="chat-thread"]')).toContainText("2 个节点 NotReady,已在 09:20 恢复。");
    // …and saying where it came from, which is the whole point of the move.
    await expect(page.locator('[data-od-id="handoff-chip"]')).toBeVisible();
    // The widget became the page: it is not drawn beside it.
    await expect(page.locator('[data-od-id="fchat-fab"]')).toHaveCount(0);
  });

  test("the sidebar's own link to the chat page hands the thread over too", async ({ page }) => {
    // ⤢ is not the only way in, and the conversation belongs to the reader, not to
    // one button: leaving through the nav has to carry the same thread.
    await stubFloatingChat(page, TURN_DONE, {
      historyOnce: [{ role: "user", content: "上次巡检的结论?" }, { role: "assistant", content: [{ type: "text", text: "2 个节点 NotReady。" }] }],
    });
    await page.goto("/");
    await page.click('[data-od-id="fchat-fab"]');
    await expect(page.locator('[data-od-id="fchat-panel"]')).toContainText("上次巡检的结论?");

    await page.click('[data-od-id="nav-copilot"]');

    await expect(page).toHaveURL(/\/cubepilot/);
    await expect(page.locator('[data-od-id="handoff-chip"]')).toBeVisible();
    await expect(page.locator('[data-od-id="chat-thread"]')).toContainText("2 个节点 NotReady。");
  });

  test("the two surfaces carry one view-transition name, so the morph has something to move between", async ({ page }) => {
    // The animation itself is the browser's and cannot be asserted here; what this
    // pins is the wiring it needs — the same name on the launcher, the panel and
    // the pane's thread, with never more than one of them on screen at a time.
    await stubFloatingChat(page, TURN_DONE);
    await page.goto("/");
    expect(await vtName(page, '[data-od-id="fchat-fab"]')).toBe("agent-chat");

    await page.click('[data-od-id="fchat-fab"]');
    // Open: the panel takes the name, the launcher gives it up.
    expect(await vtName(page, '[data-od-id="fchat-panel"]')).toBe("agent-chat");
    expect(await vtName(page, '[data-od-id="fchat-fab"]')).toBe("none");

    await page.goto("/cubepilot");
    await expect(page.locator('[data-od-id="chat-thread"]')).toBeVisible();
    // Polled: the name arrives with the agent selection, which the pane makes
    // after its own mount (the same element serves the model playground, unnamed).
    await expect.poll(() => vtName(page, '[data-od-id="chat-thread"]')).toBe("agent-chat");
  });

  test("a stale history read does not replace the thread that was handed over", async ({ page }) => {
    // The handed thread is what the reader was looking at, so it can be AHEAD of
    // the runtime: a turn still streaming, or one the writer has not caught up
    // with. The pane's own restore must not overwrite it with an older copy — the
    // assertion runs after that read has landed, and later reads answer 404 so
    // nothing can put it back.
    const captured = await stubFloatingChat(page, TURN_DONE, {
      historyOnce: [
        { role: "user", content: "上次巡检的结论?" },
        { role: "assistant", content: [{ type: "text", text: "刚跑完的那次巡检结论。" }] },
      ],
      staleHistory: [{ role: "user", content: "很早以前的那次提问" }],
    });
    await page.goto("/");
    await page.click('[data-od-id="fchat-fab"]');
    await expect(page.locator('[data-od-id="fchat-panel"]')).toContainText("刚跑完的那次巡检结论。");

    // From here every transcript read — the pane's own restore first among them —
    // answers with the older copy, so what survives is decided by the guard alone.
    captured.serveStale();
    await page.click('[data-od-id="fchat-expand"]');
    await expect(page).toHaveURL(/\/cubepilot/);
    const thread = page.locator('[data-od-id="chat-thread"]');
    // The stale read has landed by now; the handed thread is still what is on
    // screen.
    await page.waitForTimeout(2000);
    await expect(thread).toContainText("刚跑完的那次巡检结论。");
    await expect(thread).not.toContainText("很早以前的那次提问");
  });

  test("opens on the newest message, not the oldest", async ({ page }) => {
    // A conversation longer than the panel must open where the reader left it —
    // at the end. The pane has always done this; the panel restored its history
    // with the scroll pinned to the top, so the first thing a reader saw after
    // opening a long conversation was its oldest turn.
    const long = Array.from({ length: 20 }, (_, i) => [
      { role: "user", content: `第 ${i + 1} 个问题` },
      { role: "assistant", content: [{ type: "text", text: `第 ${i + 1} 个回答` }] },
    ]).flat();
    await stubFloatingChat(page, TURN_DONE, { historyOnce: long });
    await page.goto("/");
    await page.click('[data-od-id="fchat-fab"]');

    const thread = page.locator('[data-od-id="fchat-thread"]');
    await expect(thread).toContainText("第 20 个回答");
    // At the bottom: nothing left to scroll to. Asserted as "the distance to the
    // end is zero" so the case cannot pass by the thread being too short to
    // scroll at all — the fixture below overflows the panel.
    await expect.poll(() => thread.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(8);
  });

  test("comes back on the chat tab when a MODEL is what that tab shows", async ({ page }) => {
    // The chat tab IS the conversation only while the assistant is what it shows.
    // A model playground is a different chat, so the assistant belongs there —
    // hiding it would take it away exactly when a reader might want to ask about
    // what the model just said.
    await stubFloatingChat(page, TURN_DONE);
    await page.goto("/cubepilot");
    await expect(page.locator('[data-od-id="fchat-fab"]')).toHaveCount(0);
    // With the assistant selected, the thread is the named end of the morph…
    await expect.poll(() => vtName(page, '[data-od-id="chat-thread"]')).toBe("agent-chat");

    await page.click('[data-od-id="obj-qwen38-27b"]');
    await expect(page.locator('[data-od-id="fchat-fab"]')).toBeVisible();
    // …and with a model selected it is the launcher: the same two ends the route
    // change morphs between, so switching objects inside the page reads as the
    // same move rather than as one surface blinking out.
    await expect.poll(() => vtName(page, '[data-od-id="fchat-fab"]')).toBe("agent-chat");
    expect(await vtName(page, '[data-od-id="chat-thread"]')).toBe("none");

    // …and it goes away again when the assistant is what is on screen.
    await page.click('[data-od-id="obj-cubepilot"]');
    await expect(page.locator('[data-od-id="fchat-fab"]')).toHaveCount(0);
    await expect.poll(() => vtName(page, '[data-od-id="chat-thread"]')).toBe("agent-chat");
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

    // The send names the ONE fixed conversation the chat tab owns — in its
    // path, with nothing else in the body: the route decodes strictly, so a
    // leftover field would be a 400.
    await expect
      .poll(() => captured.messagePosts.length)
      .toBe(1);
    expect(decodeURIComponent(captured.messagePosts[0].path)).toContain(
      `/api/v1/sessions/${SESSION_KEY}/messages`,
    );
    expect(captured.messagePosts[0].body).toEqual({ content: "集群状态如何?" });
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
