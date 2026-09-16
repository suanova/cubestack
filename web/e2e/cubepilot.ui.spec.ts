import { expect, test, type Page } from "@playwright/test";

import type { AllowlistRule } from "../lib/cubepilot/types";
import { seedSession } from "./auth";

// Deterministic, CI-cheap e2e suite for /cubepilot's agent surface
// (ChatPane's CubePilot object + ConfigPane's agent cards). Every
// /api/cubepilot/* endpoint the panes hit is stubbed at the network level, so
// no KinD cluster, cubepilot-api or AI Gateway is required; the CR-backed
// shapes below mirror the routes' real responses (lib/cubepilot/types.ts).
// The platform locale is pinned to zh-CN (headless Chromium defaults to
// en-US).

/** The short example the argPattern input advertises as its placeholder. */
const ARG_PATTERN_EXAMPLE = String.raw`^(status|list)\b.*$`;

const SESSION_KEY = "agent:main:conv-7f3c";
const ENC_KEY = encodeURIComponent(SESSION_KEY);

/** The instance's real state, as the CR-projected endpoints report it. */
const CONFIG_READY = {
  exists: true,
  selectedModel: "glm-5.2-chat",
  userInstructions: "巡检优先,写操作全部走审批",
  // The AgentTemplate's inlined models: the page lists these (no gateway call).
  models: [
    { name: "glm-5.2-chat", endpoint: "http://ai-gateway.test:8080", origin: "external", keyed: true },
    { name: "system-only", origin: "system" },
  ],
};

const STATUS_READY = {
  exists: true,
  id: "admin-cubepilot",
  phase: "Ready",
  uptimeSeconds: 7200,
  user: "admin",
  lastActivity: new Date(Date.now() - 300_000).toISOString(),
  podName: "cubepilot-admin-7d9f",
  pvcName: "pvc-admin-cubepilot",
};

const STATUS_NONE = { exists: false, user: "admin" };

const CONFIG_NONE = {
  exists: false,
  selectedModel: "",
  userInstructions: "",
  models: [{ name: "glm-5.2-chat", endpoint: "http://ai-gateway.test:8080", origin: "external", keyed: false }],
};

/** One enabled + one disabled skill: the materialized whitelist of an
 *  instance that uninstalled a baseline skill. */
const SKILLS = {
  skills: [
    { name: "cluster-inspect", displayName: "集群巡检", description: "节点与 Pod 巡检", enabled: true },
    { name: "gpu-health", displayName: "GPU 体检", description: "GPU 温度与 ECC", enabled: false },
  ],
};

const SKILLS_BASELINE = {
  skills: [
    { name: "cluster-inspect", displayName: "集群巡检", description: "节点与 Pod 巡检", enabled: true },
    { name: "gpu-health", displayName: "GPU 体检", description: "GPU 温度与 ECC", enabled: true },
  ],
};

/** Effective posture: the template's Allowlist is inherited (override ""). */
const CONFIRM = {
  exists: true,
  confirmPolicy: "Allowlist",
  templatePolicy: "Allowlist",
  override: "",
  // The hardcoded platform defaults (abridged: the real view carries kubectl +
  // 11 read-only shell tools) followed by the caller's own rules.
  allowlist: [
    { pattern: "kubectl", label: "kubectl — read-only operations (get/list/watch/…)", owned: false },
    { pattern: "ls", label: "ls — read-only, plain args", owned: false },
    { pattern: "cat", label: "cat — read-only, plain args", owned: false },
    { pattern: "helm ls", owned: true },
  ],
  channel: "unknown",
};

function sseBody(events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/** A completed turn: deltas, a paired tool call, and a write approval. */
const TURN_APPROVAL = [
  { type: "message_start", sessionId: SESSION_KEY },
  { type: "agent_thinking", sessionId: SESSION_KEY },
  { type: "message_delta", sessionId: SESSION_KEY, delta: "正在检查 Ceph 状态…" },
  { type: "tool_call", sessionId: SESSION_KEY, name: "shell", callId: "call-1", arguments: { cmd: "ceph df" } },
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
  { type: "message_done", sessionId: SESSION_KEY },
];

/** A turn that blocks on an ask_user question with a multi-select prompt. */
const TURN_QUESTION = [
  { type: "message_start", sessionId: SESSION_KEY },
  { type: "message_delta", sessionId: SESSION_KEY, delta: "巡检前需要确认范围。" },
  {
    type: "question_pending",
    sessionId: SESSION_KEY,
    callId: "q-1",
    question: {
      questions: [
        {
          questionId: "scope",
          header: "巡检范围",
          question: "本次巡检覆盖哪些节点?",
          multiSelect: true,
          options: [{ label: "全部节点", description: "含 GPU 节点" }, { label: "仅 compute 节点" }],
        },
      ],
    },
  },
  { type: "message_done", sessionId: SESSION_KEY },
];

const HISTORY = [
  { role: "user", content: "上次巡检的结论?" },
  { role: "assistant", content: [{ type: "text", text: "上次巡检:2 个节点 NotReady,已在 09:20 恢复。" }] },
];

/** The pending write approval a blocked turn re-attaches after a reload. */
const PENDING_APPROVAL = {
  approvalId: "app-9",
  tool: "shell",
  command: "kubectl rollout restart deploy/portal",
  level: "write",
  message: "重建 Deployment 需要审批",
};

/** What the stubbed endpoints were actually called with (contract checks). */
interface Captured {
  llmPosts: Array<{ method: string; path: string; body: unknown }>;
  approvalPosts: Array<{ path: string; body: { decision?: string } }>;
  questionPosts: Array<{ path: string; body: { id?: string; answers?: Record<string, string[]>; cancel?: boolean } }>;
  pendingPaths: string[];
  configPuts: Array<{ selectedModel?: string; userInstructions?: string }>;
  confirmPuts: Array<{ confirmPolicy?: string; allowlist?: AllowlistRule[] }>;
}

interface Stubs {
  config?: typeof CONFIG_READY;
  status?: typeof STATUS_READY | typeof STATUS_NONE;
  confirm?: typeof CONFIRM;
  skills?: typeof SKILLS;
  /** null → the agent API is unavailable (503 on /sessions). */
  sessions?: object[] | null;
  history?: object[];
  turnActive?: boolean;
  pendingApproval?: object | null;
  turnEvents?: object[];
}

/** Apply the requested change to the stored posture, as the route does. */
function confirmAfterPut(body: { confirmPolicy?: string; allowlist?: AllowlistRule[] }, base: typeof CONFIRM): typeof CONFIRM {
  const override = body.confirmPolicy ?? base.override;
  const allowlist = body.allowlist
    ? [...base.allowlist.filter((r) => !r.owned), ...body.allowlist.map((r) => ({ ...r, owned: true }))]
    : base.allowlist;
  return { ...base, override, confirmPolicy: override || base.templatePolicy, allowlist };
}

/** Stub every endpoint the three panes touch with CR-shaped responses. */
async function stubAgent(page: Page, stubs: Stubs = {}): Promise<Captured> {
  const captured: Captured = { approvalPosts: [], questionPosts: [], pendingPaths: [], configPuts: [], confirmPuts: [], llmPosts: [] };
  let config = stubs.config ?? CONFIG_READY;
  let confirm = stubs.confirm ?? CONFIRM;
  const sessions = stubs.sessions === undefined ? [] : stubs.sessions;
  await page.route("**/api/cubepilot/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const post = (): unknown => JSON.parse(req.postData() ?? "{}") as unknown;

    // ── the other two tabs' panes mount too: keep them quiet ──
    if (path.endsWith("/api/cubepilot/tasks")) return json({ tasks: [], reports: [] });
    if (path.endsWith("/api/cubepilot/tasktemplates")) return json({ taskTemplates: [] });

    // ── REST: agent CR projections ──
    if (path.endsWith("/api/cubepilot/agent/config")) {
      if (method === "PUT") {
        const body = post() as { config?: { selectedModel?: string; userInstructions?: string } };
        captured.configPuts.push(body.config ?? {});
        config = {
          ...config,
          exists: true,
          selectedModel: body.config?.selectedModel ?? config.selectedModel,
          userInstructions: body.config?.userInstructions ?? config.userInstructions,
        };
      }
      return json({ config });
    }
    if (path.endsWith("/api/cubepilot/agent/status")) return json(stubs.status ?? STATUS_READY);
    if (path.endsWith("/api/cubepilot/agent/confirm")) {
      if (method === "PUT") {
        const body = post() as { confirmPolicy?: string; allowlist?: AllowlistRule[] };
        captured.confirmPuts.push(body);
        confirm = confirmAfterPut(body, confirm);
      }
      return json(confirm);
    }
    if (path.endsWith("/api/cubepilot/agent/llms") && method === "POST") {
      const body = post() as { name: string; endpoint: string; public?: boolean };
      captured.llmPosts.push({ method: "POST", path, body });
      return json({ model: { name: body.name, endpoint: body.endpoint } });
    }
    if (path.includes("/api/cubepilot/agent/llms/") && (method === "PUT" || method === "DELETE")) {
      const body = post() as { endpoint?: string; public?: boolean; apiKey?: string };
      captured.llmPosts.push({ method, path, body });
      return method === "DELETE" ? json({ deleted: decodeURIComponent(path.split("/").pop() ?? "") }) : json({ model: { name: "x" } });
    }
    if (path.endsWith("/api/cubepilot/skills")) return json(stubs.skills ?? SKILLS);
    // The chat tab still reads the gateway catalog; the config page does not.
    if (path.endsWith("/api/cubepilot/playground/services")) {
      return json({ models: [{ id: "glm-5.2-chat", ownedBy: "cubestack" }], endpoint: "http://ai-gateway.test:8080" });
    }

    // ── the agent API proxy ──
    if (path.includes("/api/cubepilot/pilot/")) {
      if (path.endsWith("/messages") && method === "POST") {
        return route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
          body: sseBody(stubs.turnEvents ?? TURN_APPROVAL),
        });
      }
      if (path.endsWith("/messages")) return json({ items: stubs.history ?? [] });
      if (path.endsWith("/api/v1/sessions")) {
        return sessions === null ? json({ error: "agent API unavailable" }, 503) : json({ sessions });
      }
      if (path.endsWith("/turn")) return json({ active: stubs.turnActive ?? false });
      if (path.endsWith("/approval/pending") || path.endsWith("/question/pending")) {
        captured.pendingPaths.push(path);
        const body = stubs.pendingApproval ?? null;
        return path.endsWith("/approval/pending") && body ? json({ approval: body }) : json({ error: "no pending request" }, 404);
      }
      if (path.endsWith("/approval") && method === "POST") {
        const body = post() as { decision?: string };
        captured.approvalPosts.push({ path, body });
        return json({ approved: body.decision !== "reject", decision: body.decision, approvalId: "app-1" });
      }
      if (path.endsWith("/question") && method === "POST") {
        captured.questionPosts.push({ path, body: post() as { id?: string; answers?: Record<string, string[]> } });
        return json({ ok: true });
      }
      if (path.endsWith("/abort") && method === "POST") return json({ ok: true });
    }
    return json({ error: `unstubbed ${method} ${path}` }, 404);
  });
  return captured;
}

async function pinLocale(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("cubestack-locale", "zh-CN");
    localStorage.setItem("cubestack-theme", "light");
  });
}

test.beforeEach(async ({ context, page }) => {
  await pinLocale(page);
  await seedSession(context);
});

test.describe("cubepilot agent chat (CR-backed data)", () => {
  test("greets with the instance's model, the allowlist and the skills", async ({ page }) => {
    await stubAgent(page);
    await page.goto("/cubepilot");

    // The object entry carries the instance's real phase.
    const obj = page.locator('[data-od-id="obj-cubepilot"]');
    await expect(obj).toContainText("Ready");
    await obj.click();

    const thread = page.locator('[data-od-id="chat-thread"]');
    await expect(thread).toContainText("技能 2 项,当前模型 glm-5.2-chat");
    await expect(thread).toContainText("会话审计已开启");

    // The rail lists the confirmation allowlist as tags: the hardcoded platform
    // defaults plus the caller's own rule.
    const allow = page.locator('[data-od-id="allowlist-card"]');
    await expect(allow).toContainText("白名单");
    await expect(allow).toContainText("4 条自动放行");
    await expect(allow).toContainText("kubectl");
    await expect(allow).toContainText("ls");
    await expect(allow).toContainText("helm ls");
    await expect(allow.locator('[data-od-id="rail-allowlist-tag"][data-owned="true"]')).toHaveCount(1);
    await expect(allow).toContainText("命中的命令直接放行");

    // Skills live in their own card (tools, not the allowlist).
    const skills = page.locator('[data-od-id="tool-whitelist-card"]');
    await expect(skills).toContainText("技能(工具)");
    await expect(skills).toContainText("2 项");
    await expect(skills).toContainText("集群巡检");
    await expect(skills).toContainText("GPU 体检");
    await expect(skills).toContainText("已启用");
    await expect(skills).toContainText("未启用");

    // The status card is the instance's own state, not a demo fixture.
    const rail = page.locator('[data-od-id="agent-status-card"]');
    await expect(rail).toContainText("最近活动");
    await expect(rail).toContainText("当前模型");
    await expect(rail).toContainText("glm-5.2-chat");
    await expect(rail).toContainText("阶段");
    await expect(rail).toContainText("Ready");

    // Write ops still route through the approval queue; the model-mode rail
    // (params/api cards) is not rendered for the agent.
    await expect(page.locator('[data-od-id="approval-card"]')).toContainText("写操作");
    await expect(page.locator('[data-od-id="params-card"]')).toHaveCount(0);
  });

  test("hides the rail allowlist under the None policy", async ({ page }) => {
    await stubAgent(page, { confirm: { ...CONFIRM, confirmPolicy: "None", override: "None" } });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();

    // None passes everything through, so there is no allowlist to show — but the
    // skills card stays.
    await expect(page.locator('[data-od-id="agent-status-card"]')).toContainText("Ready");
    await expect(page.locator('[data-od-id="allowlist-card"]')).toHaveCount(0);
    await expect(page.locator('[data-od-id="tool-whitelist-card"]')).toContainText("集群巡检");
  });

  test("asks to provision the instance when the caller has none", async ({ page }) => {
    await stubAgent(page, { status: STATUS_NONE, config: CONFIG_NONE, skills: SKILLS_BASELINE });
    await page.goto("/cubepilot");

    const obj = page.locator('[data-od-id="obj-cubepilot"]');
    await expect(obj).toContainText("实例未创建");
    await obj.click();

    const thread = page.locator('[data-od-id="chat-thread"]');
    await expect(thread).toContainText("Agent 实例尚未创建");
    await expect(thread).toContainText("「配置」页保存一次模型配置");

    // No instance → no phase, the runtime default model, and the platform
    // baseline still lists the registered skills.
    const rail = page.locator('[data-od-id="agent-status-card"]');
    await expect(rail).toContainText("状态 · —");
    await expect(rail).toContainText("运行时默认");
    await expect(page.locator('[data-od-id="tool-whitelist-card"]')).toContainText("集群巡检");
  });

  test("streams a turn and approves the write operation it blocks on", async ({ page }) => {
    const captured = await stubAgent(page, { turnEvents: TURN_APPROVAL });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();

    const thread = page.locator('[data-od-id="chat-thread"]');
    await expect(thread).toContainText("技能 2 项");
    await page.locator('[data-od-id="quick-chip"]').filter({ hasText: "分析 Ceph OSD 使用率告警" }).click();

    // The prompt bubble, the accumulated deltas and the paired tool result.
    await expect(thread).toContainText("分析 Ceph OSD 使用率告警");
    await expect(thread).toContainText("OSD 使用率 71%。");
    await expect(thread).toContainText("shell");
    await expect(thread).toContainText("POOL USED: 71%");

    // The write op blocks the turn with an approval card.
    const approval = page.locator('[data-od-id="approval-item"]');
    await expect(approval).toContainText("写操作待审批");
    await expect(approval).toContainText("ceph osd set-noscrub");
    await expect(approval).toContainText("write");
    await expect(approval).toContainText("调整 OSD 参数属于写操作");

    await page.locator('[data-od-id="approval-approve"]').click();
    await expect(approval).toContainText("已批准");
    await expect(page.locator('[data-od-id="approval-approve"]')).toHaveCount(0);

    // The decision went to the session's approval endpoint with the key
    // percent-encoded per segment, and the send button came back once the
    // turn finished.
    expect(captured.approvalPosts).toHaveLength(1);
    expect(captured.approvalPosts[0].body).toEqual({ decision: "approve" });
    expect(captured.approvalPosts[0].path).toContain(`/api/v1/sessions/${ENC_KEY}/approval`);
    await expect(page.locator('[data-od-id="send-btn"]')).toBeVisible();
    await expect(page.locator('[data-od-id="stop-btn"]')).toHaveCount(0);
  });

  test("answers an ask_user question from the stream", async ({ page }) => {
    const captured = await stubAgent(page, { turnEvents: TURN_QUESTION });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();

    await expect(page.locator('[data-od-id="chat-thread"]')).toContainText("技能 2 项");
    await page.locator('[data-od-id="quick-chip"]').filter({ hasText: "生成升级前预检结论" }).click();

    const card = page.locator('[data-od-id="question-item"]');
    await expect(card).toContainText("Agent 需要你确认");
    await expect(card).toContainText("巡检范围");
    await expect(card).toContainText("本次巡检覆盖哪些节点?");
    await expect(card).toContainText("全部节点");

    // Submit stays disabled until the multi-select prompt is answered.
    const submit = page.locator('[data-od-id="question-submit"]');
    await expect(submit).toBeDisabled();
    await card.locator("button").filter({ hasText: "仅 compute 节点" }).click();
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(card).toContainText("已回答");
    await expect(page.locator('[data-od-id="question-submit"]')).toHaveCount(0);
    expect(captured.questionPosts).toHaveLength(1);
    expect(captured.questionPosts[0].body).toEqual({ id: "q-1", answers: { scope: ["仅 compute 节点"] } });
    expect(captured.questionPosts[0].path).toContain(`/api/v1/sessions/${ENC_KEY}/question`);
  });

  test("restores the latest session, its history and a still-pending approval", async ({ page }) => {
    const captured = await stubAgent(page, {
      sessions: [{ sessionKey: SESSION_KEY, title: "Ceph 巡检" }],
      history: HISTORY,
      pendingApproval: PENDING_APPROVAL,
    });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();

    // History replaces the greeting (no fresh-start prompt).
    const thread = page.locator('[data-od-id="chat-thread"]');
    await expect(thread).toContainText("上次巡检的结论?");
    await expect(thread).toContainText("上次巡检:2 个节点 NotReady,已在 09:20 恢复。");
    await expect(thread).not.toContainText("收到。当前会话已接入集群真实数据");

    // The blocked write op is re-attached as a live card with its decisions.
    const approval = page.locator('[data-od-id="approval-item"]');
    await expect(approval).toContainText("kubectl rollout restart deploy/portal");
    await expect(approval).toContainText("重建 Deployment 需要审批");
    await expect(page.locator('[data-od-id="approval-approve"]')).toBeVisible();
    await expect(page.locator('[data-od-id="approval-reject"]')).toBeVisible();
    await expect(page.locator('[data-od-id="approval-allow"]')).toBeVisible();
    // Restore re-reads both pending queues through the encoded session key.
    const decoded = captured.pendingPaths.map((p) => decodeURIComponent(p));
    expect(decoded.some((p) => p.includes(`/api/v1/sessions/${SESSION_KEY}/approval/pending`))).toBe(true);
    expect(decoded.some((p) => p.includes(`/api/v1/sessions/${SESSION_KEY}/question/pending`))).toBe(true);
  });
});

test.describe("cubepilot config (AgentInstance CR + AgentTemplate catalog)", () => {
  test("shows the instance state, the inherited policy and persists edits", async ({ page }) => {
    const captured = await stubAgent(page);
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="cp-tab-config"]').click();

    const pane = page.locator('[data-od-id="cp-config-pane"]');
    await expect(pane).toBeVisible();

    // Model from the CR; the dropdown lists the template's own models plus the
    // system catalog (+ the runtime default).
    const modelSelect = page.locator('[data-od-id="cp-config-model-select"]');
    await expect(modelSelect).toHaveValue("glm-5.2-chat");
    await expect(modelSelect.locator("option")).toHaveCount(3);
    await expect(modelSelect).toContainText("运行时默认");
    await expect(modelSelect).toContainText("system-only");

    await expect(page.locator('[data-od-id="cp-config-prompt-input"]')).toHaveValue("巡检优先,写操作全部走审批");

    // Instance status card (CR spec + status).
    const status = page.locator('[data-od-id="cp-config-status"]');
    await expect(status).toContainText("admin-cubepilot");
    await expect(status).toContainText("Ready");
    await expect(status).toContainText("cubepilot-admin-7d9f");
    await expect(status).toContainText("pvc-admin-cubepilot");

    // Policy: only Allowlist and None are offered, defaulting to the effective
    // policy (the instance inherits, so the select shows Allowlist).
    const policy = page.locator('[data-od-id="cp-config-policy"]');
    await expect(policy.locator("option")).toHaveCount(2);
    await expect(policy).toHaveValue("Allowlist");
    const confirmCard = page.locator('[data-od-id="cp-config-confirm"]');
    await expect(confirmCard).toContainText("生效");
    await expect(confirmCard).toContainText("继承自模板");

    // The allowlist renders as tags: hardcoded platform defaults (no remove
    // control) and the caller's own rules (removable).
    const defaults = page.locator('[data-od-id="cp-allowlist-default"]');
    await expect(defaults).toContainText("平台默认");
    await expect(defaults.locator('[data-od-id="cp-allowlist-tag"]')).toHaveCount(3);
    await expect(defaults).toContainText("kubectl");
    await expect(defaults).toContainText("ls");
    // The meaning is in the tooltip (the tag itself stays a short command chip).
    await expect(defaults.locator('[data-od-id="cp-allowlist-tag"]').first()).toHaveAttribute("title", /read-only operations/);
    await expect(defaults.locator('[data-od-id="cp-allowlist-remove"]')).toHaveCount(0);
    const owned = page.locator('[data-od-id="cp-allowlist-owned"]');
    await expect(owned).toContainText("你的规则");
    await expect(owned).toContainText("helm ls");
    await expect(owned.locator('[data-od-id="cp-allowlist-remove"]')).toHaveCount(1);

    // LLM 配置: two sources — the system catalog (read-only) and your own
    // models (written to the AgentTemplate, keyed ones through a Secret).
    await expect(page.locator('[data-od-id="cp-config-llm"]')).toBeVisible();
    await expect(page.locator('[data-od-id="cp-config-llm-src-system"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-od-id="cp-config-llm-system"]')).toContainText("system-only");
    await page.locator('[data-od-id="cp-config-llm-src-external"]').click();
    await expect(page.locator('[data-od-id="cp-config-llm-external"]')).toContainText("glm-5.2-chat");
    await expect(page.locator('[data-od-id="cp-config-llm-external"]')).toContainText("密钥");

    await page.locator('[data-od-id="cp-config-llm-name"]').fill("Local Qwen");
    await page.locator('[data-od-id="cp-config-llm-endpoint"]').fill("http://llm.local:8080/v1/chat/completions");
    await page.locator('[data-od-id="cp-config-llm-public"]').check();
    await page.locator('[data-od-id="cp-config-llm-save"]').click();
    await expect(page.getByText('已添加模型「Local Qwen」')).toBeVisible();
    expect(captured.llmPosts.at(-1)).toEqual({
      method: "POST",
      path: "/api/cubepilot/agent/llms",
      body: { name: "Local Qwen", endpoint: "http://llm.local:8080/v1/chat/completions", public: true },
    });

    // Editing prefills the form; the name is immutable.
    await page.locator('[data-od-id="cp-config-llm-edit"]').first().click();
    await expect(page.locator('[data-od-id="cp-config-llm-name"]')).toBeDisabled();
    await page.locator('[data-od-id="cp-config-llm-endpoint"]').fill("http://gw.test:9090/v1");
    await page.locator('[data-od-id="cp-config-llm-save"]').click();
    await expect(page.getByText("已更新模型「glm-5.2-chat」")).toBeVisible();
    expect(captured.llmPosts.at(-1)).toMatchObject({ method: "PUT", body: { endpoint: "http://gw.test:9090/v1" } });

    // Removing asks for confirmation and deletes by name.
    page.on("dialog", (d) => void d.accept());
    await page.locator('[data-od-id="cp-config-llm-remove"]').first().click();
    await expect(page.getByText("已删除模型「glm-5.2-chat」")).toBeVisible();
    expect(captured.llmPosts.at(-1)).toMatchObject({ method: "DELETE" });

    // The argPattern input advertises a short regex example as its placeholder.
    await expect(page.locator('[data-od-id="cp-config-rule-arg"]')).toHaveAttribute("placeholder", ARG_PATTERN_EXAMPLE);

    // Adding a rule persists the instance's own list (defaults are hardcoded).
    await page.locator('[data-od-id="cp-config-rule-pattern"]').fill("ceph df");
    await page.locator('[data-od-id="cp-config-rule-add"]').click();
    await expect(owned).toContainText("ceph df");
    expect(captured.confirmPuts.at(-1)?.allowlist).toEqual([{ pattern: "helm ls", owned: true }, { pattern: "ceph df", owned: true }]);

    // Removing an own rule drops just that one from the CR payload (the stub
    // echoes the patched view, like the route does).
    await owned.locator('[data-od-id="cp-allowlist-remove"]').last().click();
    await expect(owned).not.toContainText("ceph df");
    expect(captured.confirmPuts.at(-1)?.allowlist).toEqual([{ pattern: "helm ls", owned: true }]);

    // 恢复平台默认白名单 clears the override and the own rules in one PUT
    // (the route removes the enum-validated field instead of writing "").
    await page.getByRole("button", { name: "恢复平台默认白名单" }).click();
    expect(captured.confirmPuts.at(-1)).toEqual({ confirmPolicy: "", allowlist: [] });
    await expect(confirmCard).toContainText("继承自模板");
    await expect(owned).toHaveCount(1);

    // Saving the model/prompt hits the config route and confirms with a toast.
    await page.locator('[data-od-id="cp-config-save"]').click();
    await expect(page.getByText("配置已保存,模型与系统提示词下轮生效")).toBeVisible();
    expect(captured.configPuts.at(-1)).toEqual({ selectedModel: "glm-5.2-chat", userInstructions: "巡检优先,写操作全部走审批" });
  });

  test("switching the policy to None persists the override and hides the allowlist", async ({ page }) => {
    const captured = await stubAgent(page);
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="cp-tab-config"]').click();

    await page.locator('[data-od-id="cp-config-policy"]').selectOption("None");
    const confirmCard = page.locator('[data-od-id="cp-config-confirm"]');
    await expect(confirmCard).toContainText("生效");
    await expect(confirmCard).toContainText("你已覆盖");
    await expect(confirmCard).toContainText("None 直通全部操作(已审计) — 白名单不生效。");
    await expect(page.locator('[data-od-id="cp-allowlist-default"]')).toHaveCount(0);
    await expect(page.locator('[data-od-id="cp-config-rule-pattern"]')).toHaveCount(0);
    expect(captured.confirmPuts.at(-1)).toEqual({ confirmPolicy: "None" });
  });

  test("keeps the page usable when the template declares no models", async ({ page }) => {
    await stubAgent(page, { config: { ...CONFIG_READY, selectedModel: "", models: [] } });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="cp-tab-config"]').click();

    // No template models: only the runtime default is selectable, and the page
    // says so instead of failing on a missing gateway.
    const pane = page.locator('[data-od-id="cp-config-pane"]');
    await expect(pane).toContainText("模板未声明模型");
    await page.locator('[data-od-id="cp-config-llm-src-external"]').click();
    await expect(page.locator('[data-od-id="cp-config-llm"]')).toContainText("模板暂未声明模型");
    await expect(page.locator('[data-od-id="cp-config-model-select"]').locator("option")).toHaveCount(1);
    await expect(page.locator('[data-od-id="cp-config-prompt-input"]')).toHaveValue("巡检优先,写操作全部走审批");
    await expect(page.locator('[data-od-id="cp-config-status"]')).toContainText("admin-cubepilot");
  });
});
