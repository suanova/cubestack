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

// The pane's conversation key is a literal (agentThread-adjacent: see
// ChatPane's SESSION_KEY). The fixtures use the same one so a spec exercises
// the real path — the server echoes back the key it was sent, so nothing
// changes mid-turn.
const SESSION_KEY = "agent:main:conv-portal";
const ENC_KEY = encodeURIComponent(SESSION_KEY);

/** The session the viewer picks before sending a fresh turn. */
const SESSION = { sessionKey: SESSION_KEY, title: "Ceph 巡检" };

/** The instance's real state, as the CR-projected endpoints report it. */
const CONFIG_READY = {
  exists: true,
  // The agent always runs the platform provider: the save writes the
  // "<provider>/<model id>" ref the operator resolves.
  selectedModel: "cubestack/qwen38-27b",
  userInstructions: "巡检优先,写操作全部走审批",
  providers: [
    { name: "cubestack", endpoint: "http://ai-gateway.test:8080/v1", models: ["qwen38-27b"], origin: "system" },
    {
      name: "glm-5.2-chat",
      endpoint: "http://ai-gateway.test:8080",
      models: ["glm-5.2-chat"],
      origin: "external",
      keyed: true,
    },
  ],
  gatewayModels: ["qwen38-27b", "system-only"],
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
  providers: [
    { name: "glm-5.2-chat", endpoint: "http://ai-gateway.test:8080", models: ["glm-5.2-chat"], origin: "external", keyed: false },
  ],
  gatewayModels: [],
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


/** A turn parked on a write approval.
 *
 *  It carries NO terminal, and must not: a turn waiting on a human has not
 *  ended — the stream stays open until the card is resolved. The stub cannot
 *  hold a stream open, so the body simply ends and the client reports the stream
 *  as lost; either way the card stays answerable, which is what the specs below
 *  are about. A trailing `message_done` would claim the turn was over while the
 *  card was still parked, and a turn that really does end settles its parked
 *  cards (nobody decided them) — the opposite of what these specs assert. */
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
];

/** A turn whose narration continues after the tool call — the ordering case. */
const TURN_TOOL_THEN_TEXT = [
  { type: "message_start", sessionId: SESSION_KEY },
  { type: "message_delta", sessionId: SESSION_KEY, delta: "先查一下。" },
  { type: "tool_call", sessionId: SESSION_KEY, name: "shell", callId: "call-1", arguments: { cmd: "ceph df" } },
  { type: "tool_result", sessionId: SESSION_KEY, callId: "call-1", name: "shell", output: "POOL USED: 71%" },
  { type: "message_delta", sessionId: SESSION_KEY, delta: "使用率 71%。" },
  { type: "message_done", sessionId: SESSION_KEY },
];

/** A turn whose agent narrates between its tool calls (cubepilot #216). The
 *  narration arrives as a SNAPSHOT per block, not as a delta, and carries no
 *  run of its own — it is what the agent says before it calls the next tool. */
const TURN_NARRATION = [
  { type: "message_start", sessionId: SESSION_KEY },
  { type: "narration", sessionId: SESSION_KEY, blockId: "n1", text: "先看节点。" },
  { type: "tool_call", sessionId: SESSION_KEY, name: "exec", callId: "call-1", arguments: { command: "kubectl get nodes" } },
  { type: "tool_result", sessionId: SESSION_KEY, callId: "call-1", name: "exec", output: "clyang" },
  { type: "narration", sessionId: SESSION_KEY, blockId: "n2", text: "节点正常,再看 Pod。" },
  { type: "message_delta", sessionId: SESSION_KEY, delta: "共 1 个节点。" },
  { type: "message_done", sessionId: SESSION_KEY },
];

/** An ask_user prompt the human may answer in their own words.
 *
 *  `isOther` is a field of the QUESTION, not of the prompt (api.md §4.6: it sits
 *  inside the item object, beside `options`), and `ask_user` sets it on every
 *  question it asks. The card read it one level up, off the prompt, where it
 *  never arrives — so the free-text entry never appeared. The second question
 *  carries no options at all: that is free-text-only whether or not the flag
 *  arrived, which is the rule the reference applies. */
const TURN_QUESTION_FREE_TEXT = [
  { type: "message_start", sessionId: SESSION_KEY },
  {
    type: "question_pending",
    sessionId: SESSION_KEY,
    callId: "q-free",
    question: {
      questions: [
        { questionId: "note", header: "补充说明", question: "还有什么要告诉我的?", options: [{ label: "没有" }], isOther: true },
        { questionId: "reason", header: "原因", question: "为什么现在做?" },
      ],
    },
  },
];

/** A reply carrying the Markdown an agent actually emits. */
const TURN_MARKDOWN = [
  { type: "message_start", sessionId: SESSION_KEY },
  { type: "message_delta", sessionId: SESSION_KEY, delta: "可以这样查:\n\n```sh\nkubectl get pods -A\n```\n\n然后:\n\n- 检查节点\n- 检查 DevicePlugin\n\n| 服务 | 状态 |\n|---|---|\n| qwen38 | Ready |\n" },
  { type: "message_done", sessionId: SESSION_KEY },
];

/** A turn that blocks on an ask_user question with a multi-select prompt.
 *
 *  No terminal here either, for the same reason as TURN_APPROVAL: the agent is
 *  parked on the human, so the turn has not ended and its question must stay
 *  answerable (a real terminal would settle it as dismissed). */
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
];

/** What GET .../question/pending reports while the question is still open: the
 *  same prompt TURN_QUESTION streamed, plus the gateway's own remaining time. */
const PENDING_QUESTION = {
  id: "q-1",
  questions: [
    {
      questionId: "scope",
      header: "巡检范围",
      question: "本次巡检覆盖哪些节点?",
      multiSelect: true,
      options: [{ label: "全部节点", description: "含 GPU 节点" }, { label: "仅 compute 节点" }],
    },
  ],
  timeoutSeconds: 30,
};

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
  /** Every GET the pane made for a session's history, in order. Restoring the
   *  right session is a claim about WHICH key was read — the stub answers every
   *  key with the same body, so the path is the only evidence. */
  historyPaths: string[];
  /** How many times the pane asked for the runtime's session LIST. The pane has
   *  one conversation surface and remembers its own key, so this must stay 0:
   *  choosing from that list is what picked a cron/task session and broke the
   *  page open. */
  sessionListCalls: number;
  /** The most history reads that were ever in flight at once. The follow loop
   *  must never overlap them: an interval fires on its own clock, so a slow read
   *  would run alongside the next one and the older answer could land last,
   *  putting the transcript backwards. */
  maxHistoryInFlight: number;
  /** Every POST that started a turn, with its body: which session it named is
   *  the whole question — a body without `sessionId` lets the API mint one. */
  messagePosts: Array<{ path: string; body: { content?: string; sessionId?: string } }>;
  /** Every DELETE the pane made for a session, in order. */
  sessionDeletes: string[];
  /** How many times the pane asked whether the session's turn is running. The
   *  pane watches the conversation for as long as it is on screen, not only while
   *  it believes a turn is in flight — the conversation can move without this
   *  pane having done anything. */
  turnReads: number;
  configPuts: Array<{ selectedModel?: string; userInstructions?: string }>;
  confirmPuts: Array<{ confirmPolicy?: string; allowlist?: AllowlistRule[] }>;
  /** Every POST the pane made to the agent API, in the order it made them. The
   *  stop-then-send route is a claim about that ORDER — an abort on the wire
   *  before the message — so neither request can be checked on its own. */
  agentPosts: string[];
}

interface Stubs {
  config?: typeof CONFIG_READY;
  status?: typeof STATUS_READY | typeof STATUS_NONE;
  confirm?: typeof CONFIRM;
  skills?: typeof SKILLS;
  /** null → the agent API is unavailable (503 on /sessions). */
  sessions?: object[] | null;
  history?: object[];
  /** Successive /messages bodies, the last one repeating. Lets a spec watch the
   *  transcript update WHILE a turn runs, which is the no-local-stream case. */
  historySequence?: object[][];
  /** Makes each history read take this long. Longer than the follow loop's
   *  period, which is what a reader on a slow link sees. */
  historyDelayMs?: number;
  turnActive?: boolean;
  /** Makes the instance-status read slow, which keeps the pane inside its
   *  "selecting CubePilot" window long enough to send during it. */
  statusDelayMs?: number;
  /** What the restore read of /question/pending finds. Absent → the read 404s,
   *  which is the ordinary "nothing is pending". */
  pendingQuestion?: object | null;
  /** Successive /turn answers, the last one repeating. Lets a spec watch the
   *  pane pick up a turn that STARTS after the conversation has settled — the
   *  conversation is the user's, not this tab's, so it can move without this
   *  pane having done anything. */
  turnSequence?: boolean[];
  /** The /turn read itself fails (502, as the route answers when it could not
   *  determine). "Could not check" is not the same as "nothing is running". */
  turnCheckFails?: boolean;
  pendingApproval?: object | null;
  turnEvents?: object[];
  /** What POST /question answers with. 404/409 are the refusals that send the
   *  pane to the pending list instead of letting it guess at the outcome. */
  questionPostStatus?: number;
  /** The pending list once an answer has been refused: the same question still
   *  open (the answer was not accepted) or an empty list (it is gone). */
  pendingQuestionKept?: boolean;
  pendingQuestionMissing?: boolean;
  /** That read's own status, to drive the branch where it 404s — this endpoint's
   *  404 means "no pending question", i.e. gone, not "the read failed". */
  pendingQuestionStatus?: number;
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
  const captured: Captured = { approvalPosts: [], questionPosts: [], pendingPaths: [], historyPaths: [], sessionListCalls: 0, maxHistoryInFlight: 0, sessionDeletes: [], messagePosts: [], turnReads: 0, configPuts: [], confirmPuts: [], llmPosts: [], agentPosts: [] };
  let config = stubs.config ?? CONFIG_READY;
  let confirm = stubs.confirm ?? CONFIRM;
  // The pending list reflects the post-refusal world only once an answer has
  // been refused. The restore read that runs when the session is first picked
  // must still see nothing pending, or it would attach the card before the turn
  // that raises it has even started.
  let refusedAnswer = false;
  let messagesRead = 0;
  let turnReads = 0;
  let historyInFlight = 0;
  /** Set by a DELETE: the session and its transcript are gone. */
  let sessionGone = false;
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
    if (path.endsWith("/api/cubepilot/agent/status")) {
      if (stubs.statusDelayMs) await new Promise((r) => setTimeout(r, stubs.statusDelayMs));
      return json(stubs.status ?? STATUS_READY);
    }
    if (path.endsWith("/api/cubepilot/agent/confirm")) {
      if (method === "PUT") {
        const body = post() as { confirmPolicy?: string; allowlist?: AllowlistRule[] };
        captured.confirmPuts.push(body);
        confirm = confirmAfterPut(body, confirm);
      }
      return json(confirm);
    }
    if (path.endsWith("/api/cubepilot/agent/llms") && method === "POST") {
      const body = post() as { name: string; endpoint: string; models?: string[]; public?: boolean };
      captured.llmPosts.push({ method: "POST", path, body });
      return json({ provider: { name: body.name, endpoint: body.endpoint, models: body.models ?? [] } });
    }
    if (path.includes("/api/cubepilot/agent/llms/") && (method === "PUT" || method === "DELETE")) {
      const body = post() as { endpoint?: string; models?: string[]; public?: boolean; apiKey?: string };
      captured.llmPosts.push({ method, path, body });
      return method === "DELETE"
        ? json({ deleted: decodeURIComponent(path.split("/").pop() ?? "") })
        : json({ provider: { name: "x", endpoint: body.endpoint, models: body.models ?? [] } });
    }
    if (path.endsWith("/api/cubepilot/skills")) return json(stubs.skills ?? SKILLS);
    // The chat tab still reads the gateway catalog; the config page does not.
    if (path.endsWith("/api/cubepilot/playground/services")) {
      return json({ models: [{ id: "glm-5.2-chat", ownedBy: "cubestack" }], endpoint: "http://ai-gateway.test:8080" });
    }

    // ── the agent API proxy ──
    if (path.includes("/api/cubepilot/pilot/")) {
      if (method === "POST") captured.agentPosts.push(path);
      // Clearing the conversation (cubepilot #214): DELETE names the session
      // itself. The stub models what the real one does — the transcript is gone
      // afterwards — because a pane that deleted server-side but kept drawing
      // the old history would pass any assertion that only checked the request.
      if (method === "DELETE") {
        captured.sessionDeletes.push(path);
        sessionGone = true;
        return json({ deleted: true, archived: [] });
      }
      if (path.endsWith("/messages") && method === "POST") {
        captured.messagePosts.push({ path, body: post() as { content?: string; sessionId?: string } });
        return route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
          body: sseBody(stubs.turnEvents ?? TURN_APPROVAL),
        });
      }
      if (path.endsWith("/messages")) {
        // A cleared session has no conversation: the route answers 404, which
        // the pane reads as "this one has not started" and greets.
        if (sessionGone) return json({ error: "no such session" }, 404);
        captured.historyPaths.push(path);
        historyInFlight++;
        captured.maxHistoryInFlight = Math.max(captured.maxHistoryInFlight, historyInFlight);
        if (stubs.historyDelayMs) await new Promise((r) => setTimeout(r, stubs.historyDelayMs));
        const body = stubs.historySequence?.length
          ? { items: stubs.historySequence[Math.min(messagesRead++, stubs.historySequence.length - 1)] }
          : { items: stubs.history ?? [] };
        historyInFlight--;
        return json(body);
      }
      if (path.endsWith("/api/v1/sessions")) {
        captured.sessionListCalls++;
        return sessions === null ? json({ error: "agent API unavailable" }, 503) : json({ sessions });
      }
      if (path.endsWith("/turn")) {
        // A failed check is the API's own 502: it could not determine, which is
        // not the same answer as "no turn is running".
        if (stubs.turnCheckFails) return json({ error: "could not check" }, 502);
        captured.turnReads++;
        if (stubs.turnSequence?.length) {
          const i = Math.min(turnReads++, stubs.turnSequence.length - 1);
          return json({ active: stubs.turnSequence[i] });
        }
        return json({ active: stubs.turnActive ?? false });
      }
      if (path.endsWith("/approval/pending")) {
        captured.pendingPaths.push(path);
        const body = stubs.pendingApproval ?? null;
        return body ? json({ approval: body }) : json({ error: "no pending request" }, 404);
      }
      if (path.endsWith("/question/pending")) {
        captured.pendingPaths.push(path);
        // A question the gateway is still holding, as the restore read sees it:
        // the endpoint answers with the LIST of them, and this fixture is one.
        if (stubs.pendingQuestion) return json({ questions: [stubs.pendingQuestion] });
        if (refusedAnswer) {
          if (stubs.pendingQuestionStatus) return json({ error: "no pending question" }, stubs.pendingQuestionStatus);
          if (stubs.pendingQuestionKept) return json({ questions: [PENDING_QUESTION] });
          if (stubs.pendingQuestionMissing) return json({ questions: [] });
        }
        // The endpoint's real 404 body: "the question is not there".
        return json({ error: "no pending question" }, 404);
      }
      if (path.endsWith("/approval") && method === "POST") {
        const body = post() as { decision?: string };
        captured.approvalPosts.push({ path, body });
        return json({ approved: body.decision !== "reject", decision: body.decision, approvalId: "app-1" });
      }
      if (path.endsWith("/question") && method === "POST") {
        captured.questionPosts.push({ path, body: post() as { id?: string; answers?: Record<string, string[]> } });
        if (stubs.questionPostStatus) {
          refusedAnswer = true;
          return json({ error: "question is no longer open" }, stubs.questionPostStatus);
        }
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
  test("greets with the instance's model and shows its state in the card header", async ({ page }) => {
    await stubAgent(page);
    await page.goto("/cubepilot");

    // The object entry carries the instance's real phase.
    const obj = page.locator('[data-od-id="obj-cubepilot"]');
    await expect(obj).toContainText("Ready");
    await obj.click();

    const thread = page.locator('[data-od-id="chat-thread"]');
    // The greeting is data-driven: the instance's skills and model from the CRs.
    await expect(thread).toContainText("技能 2 项,当前模型 qwen38-27b");
    await expect(thread).toContainText("会话审计已开启");

    // The chat tab has no context rail: the instance state lives in the card
    // header (phase pill + activity line), not in a right-hand card column.
    await expect(page.locator('[data-od-id="chat-card"]')).toContainText("Ready");
    await expect(page.locator('[data-od-id="allowlist-card"]')).toHaveCount(0);
    await expect(page.locator('[data-od-id="tool-whitelist-card"]')).toHaveCount(0);
    await expect(page.locator('[data-od-id="agent-status-card"]')).toHaveCount(0);
    await expect(page.locator('[data-od-id="approval-card"]')).toHaveCount(0);
    await expect(page.locator('[data-od-id="params-card"]')).toHaveCount(0);
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

    // No instance → the card header carries the not-provisioned line and no
    // context rail is rendered.
    await expect(page.locator('[data-od-id="chat-card"]')).toContainText("实例未创建");
    await expect(page.locator('[data-od-id="agent-status-card"]')).toHaveCount(0);
    await expect(page.locator('[data-od-id="tool-whitelist-card"]')).toHaveCount(0);
  });

  test("streams a turn and approves the write operation it blocks on", async ({ page }) => {
    const captured = await stubAgent(page, { turnEvents: TURN_APPROVAL });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();

    const thread = page.locator('[data-od-id="chat-thread"]');
    await expect(thread).toContainText("技能 2 项");
    await page.locator('[data-od-id="chat-input"]').fill("分析 Ceph OSD 使用率告警");
    await page.locator('[data-od-id="send-btn"]').click();

    // The prompt bubble, the accumulated deltas and the paired tool result. A
    // tool that has returned rests collapsed — its output is one click away,
    // which is the point of the card — so reading it means opening the card.
    await expect(thread).toContainText("分析 Ceph OSD 使用率告警");
    await expect(thread).toContainText("OSD 使用率 71%。");
    await expect(thread).toContainText("shell");
    await page.locator('[data-od-id="tool-card-head"]').first().click();
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
    await page.locator('[data-od-id="chat-input"]').fill("生成升级前预检结论");
    await page.locator('[data-od-id="send-btn"]').click();

    const card = page.locator('[data-od-id="question-item"]');
    await expect(card).toContainText("Agent 需要你确认");
    await expect(card).toContainText("巡检范围");
    await expect(card).toContainText("本次巡检覆盖哪些节点?");
    await expect(card).toContainText("全部节点");

    // The parked question owns the header line, ahead of the lost transport the
    // fixture's missing terminal produces (see the docked-approval spec above).
    await expect(page.locator('[data-od-id="agent-status"]')).toContainText("等待你的回答");

    // Submit stays disabled until the multi-select prompt is answered.
    const submit = page.locator('[data-od-id="question-submit"]');
    await expect(submit).toBeDisabled();
    await card.locator("button").filter({ hasText: "仅 compute 节点" }).click();
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(card).toContainText("已回答");
    await expect(page.locator('[data-od-id="question-submit"]')).toHaveCount(0);
    // And the settled card is the RECORD of that answer: the option that was
    // chosen is still marked as chosen. Starting the card's state empty meant a
    // decided question read as a blank form — what was asked, and not what was
    // answered.
    await expect(card.locator('button[aria-pressed="true"]')).toContainText("仅 compute 节点");
    expect(captured.questionPosts).toHaveLength(1);
    expect(captured.questionPosts[0].body).toEqual({ id: "q-1", answers: { scope: ["仅 compute 节点"] } });
    expect(captured.questionPosts[0].path).toContain(`/api/v1/sessions/${ENC_KEY}/question`);
  });

  test("restores the conversation, its history and a still-pending approval", async ({ page }) => {
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

  test("restores the one fixed conversation, and never reads the session list", async ({ page }) => {
    // The key is a literal, so every browser this user opens lands on the same
    // conversation — a key remembered in localStorage is per browser PROFILE,
    // and a user opening the portal elsewhere started a second one.
    //
    // The runtime's session list is never read either: it also carries the
    // runtime's OWN sessions (scheduled-task runs, cron firings) whose keys
    // belong to a run, and restoring one made the gateway refuse with
    // "…is owned by …:run:…, not …" on opening the page.
    const captured = await stubAgent(page, {
      sessions: [
        { sessionKey: "agent:main:cron:ad53bca9-1f9e", title: "cron" },
        { sessionKey: "agent:main:task-admin-task-abc", title: "task" },
        SESSION,
      ],
      history: HISTORY,
    });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();

    await expect(page.locator('[data-od-id="chat-thread"]')).toContainText("上次巡检的结论?");

    // The list is never read, and the history read names the FIXED key — not
    // whichever session happened to be newest.
    expect(captured.sessionListCalls).toBe(0);
    // `.some` not `toContain`: on an array `toContain` wants the whole element,
    // and these are full paths — the substring is what identifies the key.
    expect(
      captured.historyPaths.map((p) => decodeURIComponent(p)).some((p) => p.includes("/sessions/agent:main:conv-portal/messages")),
    ).toBe(true);
  });

  test("a turn running elsewhere updates the transcript while it runs", async ({ page }) => {
    // This view has no stream — the turn was started in ANOTHER browser (one
    // fixed key means one conversation, so that is now the ordinary case) or its
    // own stream died. Re-reading the history is the only way its output can
    // appear BEFORE the turn ends, and the runtime does write a running turn into
    // it as it goes. Without the poll the view sits frozen until the turn is over,
    // which reads as "the agent is running and producing nothing".
    await stubAgent(page, {
      sessions: [SESSION],
      turnActive: true,
      historySequence: [
        [{ role: "user", content: "在跑吗?" }],
        [
          { role: "user", content: "在跑吗?" },
          { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "exec", arguments: { command: "kubectl get nodes" } }] },
        ],
      ],
    });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();
    await expect(page.locator('[data-od-id="agent-status"]')).toContainText("仍在运行");

    // No interaction at all: the 3s poll brings the tool call in on its own.
    await expect(page.locator('[data-od-id="agent-bubble"] [data-od-id="tool-card"]')).toHaveCount(1, {
      timeout: 15_000,
    });
  });

  test("a turn that starts after the pane settled is picked up", async ({ page }) => {
    // The conversation belongs to the user, not to this tab. A pane that decides
    // once — "nothing is running, so there is nothing to watch" — never learns
    // otherwise, and a turn started in another window leaves it frozen for good.
    // What that looks like on screen is staler than it sounds: a transcript half
    // an hour back, a header saying the last turn had finished while a turn was
    // running, and the approval the agent was parked on never drawn — so it was
    // never answered, and the run was aborted for being stuck.
    const captured = await stubAgent(page, {
      sessions: [SESSION],
      turnSequence: [false, false, true, true, true, true, true, true],
      historySequence: [
        [{ role: "user", content: "在跑吗?" }],
        [
          { role: "user", content: "在跑吗?" },
          { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "exec", arguments: { command: "kubectl get nodes" } }] },
        ],
      ],
    });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();

    // It settles first: the load-time check and the first tick both say idle, and
    // the thread holds only what was there.
    await expect(page.locator('[data-od-id="chat-thread"]')).toContainText("在跑吗?");
    await expect(page.locator('[data-od-id="agent-status"]')).not.toContainText("仍在运行");

    // Nothing is clicked from here. The turn that starts afterwards has to be
    // noticed by the pane on its own.
    await expect(page.locator('[data-od-id="agent-status"]')).toContainText("仍在运行", { timeout: 20_000 });
    await expect(page.locator('[data-od-id="agent-bubble"] [data-od-id="tool-card"]')).toHaveCount(1, {
      timeout: 20_000,
    });
    expect(captured.turnReads).toBeGreaterThan(2);
  });

  test("never runs two history reads at once", async ({ page }) => {
    // The follow loop schedules its next tick when the last one finishes, not on
    // a fixed clock. An interval would fire during a slow read, and the two
    // answers can land in either order — the older snapshot arriving last, the
    // transcript jumping backwards, and only a later tick repairing it. A read
    // slower than the period is the ordinary case on a slow link, not a corner.
    const captured = await stubAgent(page, {
      sessions: [SESSION],
      turnActive: true,
      historyDelayMs: 4000,
      historySequence: [
        [{ role: "user", content: "在跑吗?" }],
        [
          { role: "user", content: "在跑吗?" },
          { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "exec", arguments: { command: "kubectl get nodes" } }] },
        ],
      ],
    });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();

    await expect(page.locator('[data-od-id="agent-bubble"] [data-od-id="tool-card"]')).toHaveCount(1, {
      timeout: 30_000,
    });
    // At least two reads, or "never more than one in flight" would hold for a
    // loop that only ever ran once.
    expect(captured.historyPaths.length).toBeGreaterThan(1);
    expect(captured.maxHistoryInFlight).toBe(1);
  });

  test("draws the agent's between-tool narration where it happened", async ({ page }) => {
    // The stream used to carry the tool cards and the final answer and nothing
    // between them: the cards appeared one after another with no account of what
    // the agent had found or was about to do — while the same turn read back from
    // history showed every step. The narration now arrives as its own event, and
    // it belongs between the cards, not gathered at the end.
    await stubAgent(page, { sessions: [SESSION], turnEvents: TURN_NARRATION });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();
    await page.locator('[data-od-id="chat-input"]').fill("看看集群");
    await page.locator('[data-od-id="send-btn"]').click();

    const bubble = page.locator('[data-od-id="agent-bubble"]').last();
    await expect(bubble.locator("[data-od-block]")).toHaveCount(4);
    const order = await bubble.locator('[data-od-block]').evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-od-block")),
    );
    // narration, the card it introduced, the next narration, then the answer.
    expect(order).toEqual(["text", "tool", "text", "text"]);
    await expect(bubble).toContainText("先看节点。");
    await expect(bubble).toContainText("节点正常,再看 Pod。");
    // The answer is its own block: merging it into the narration above would
    // print the conclusion inside the sentence introducing the tool call.
    await expect(bubble).toContainText("共 1 个节点。");
  });

  test("clears the conversation: asks first, deletes it, and starts fresh", async ({ page }) => {
    // The transcript is in the runtime under one fixed key, so a local "clear"
    // would bring the same conversation back on the next read — the button only
    // means something because cubepilot #214 deletes the session itself. It is
    // destructive and there is no undo, so the question comes first: that is the
    // last moment the choice can be made.
    const captured = await stubAgent(page, { sessions: [SESSION], history: HISTORY });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();
    await expect(page.locator('[data-od-id="chat-thread"]')).toContainText("上次巡检的结论?");

    // Declining sends nothing at all.
    page.once("dialog", (d) => void d.dismiss());
    await page.locator('[data-od-id="clear-agent"]').click();
    await expect(page.locator('[data-od-id="chat-thread"]')).toContainText("上次巡检的结论?");
    expect(captured.sessionDeletes).toEqual([]);

    page.once("dialog", (d) => void d.accept());
    await page.locator('[data-od-id="clear-agent"]').click();

    await expect.poll(() => captured.sessionDeletes.length).toBe(1);
    // The key is the whole tail of the path, percent-encoded: the API's DELETE
    // names the session, and `agent:main:conv-portal` is what it has to name.
    expect(decodeURIComponent(captured.sessionDeletes[0])).toContain(`/api/v1/sessions/${SESSION_KEY}`);

    // And the pane starts over rather than keeping a transcript the server no
    // longer has: the thread is the greeting a first-time visitor gets.
    await expect(page.locator('[data-od-id="chat-thread"]')).not.toContainText("上次巡检的结论?");
    await expect(page.locator('[data-od-id="chat-thread"]')).toContainText("收到。");
  });

  test("answers an ask_user question in the human's own words", async ({ page }) => {
    const captured = await stubAgent(page, { turnEvents: TURN_QUESTION_FREE_TEXT });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();
    await page.locator('[data-od-id="chat-input"]').fill("生成升级前预检结论");
    await page.locator('[data-od-id="send-btn"]').click();

    const card = page.locator('[data-od-id="question-item"]');
    await expect(card).toContainText("还有什么要告诉我的?");

    // One free-text entry for the question that declares it, one for the
    // question that offers nothing else to pick.
    const free = card.getByLabel("其他…");
    await expect(free).toHaveCount(2);

    // Submit stays disabled until every question has an answer — and an option
    // is not required for the one that has none.
    const submit = page.locator('[data-od-id="question-submit"]');
    await expect(submit).toBeDisabled();
    await card.locator("button").filter({ hasText: "没有" }).click();
    await expect(submit).toBeDisabled();
    await free.first().fill("副本数先按 2 来");
    await expect(submit).toBeDisabled();
    await free.nth(1).fill("业务要上线了");
    await expect(submit).toBeEnabled();
    await submit.click();

    expect(captured.questionPosts).toHaveLength(1);
    expect(captured.questionPosts[0].body).toEqual({
      id: "q-free",
      answers: { note: ["没有", "副本数先按 2 来"], reason: ["业务要上线了"] },
    });
  });

  test("sends on the fixed key even before the restore finishes", async ({ page }) => {
    // The composer is live the moment CubePilot is selected, and the restore
    // behind it is asynchronous — metadata first, then history. Selecting used
    // to clear the key during that window, so a send inside it went out with no
    // `sessionId` at all and the API minted a session of its own: one user, two
    // conversations, which is the whole thing the fixed key exists to prevent.
    const captured = await stubAgent(page, { sessions: [SESSION], history: HISTORY, statusDelayMs: 4000 });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();

    await page.locator('[data-od-id="chat-input"]').fill("趁恢复还没完就发");
    await page.locator('[data-od-id="send-btn"]').click();

    await expect.poll(() => captured.messagePosts.length).toBe(1);
    expect(captured.messagePosts[0].body.sessionId).toBe(SESSION_KEY);
  });

  test("restores a pending question with the countdown the gateway gave it", async ({ page }) => {
    // The pending read reports what is LEFT of the gateway's deadline. Dropping
    // it left a reloaded question with no deadline at all, so its countdown
    // never ran and its controls stayed live past the point the gateway had
    // given it — an answer that could only come back refused.
    await stubAgent(page, { sessions: [SESSION], history: HISTORY, pendingQuestion: PENDING_QUESTION });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();

    const card = page.locator('[data-od-id="question-item"]');
    await expect(card).toContainText("本次巡检覆盖哪些节点?");
    // The live card's pill counts down from the remainder; a restored card with
    // no deadline shows the awaiting label with no number.
    await expect(card).toContainText(/等待回答 · \d+s/);
  });

  test("follows the transcript when its own stream is lost", async ({ page }) => {
    // The pane's stream is its own view of the turn, and the run outlives it —
    // a dropped connection is not the turn ending. It used to keep the frozen
    // bubble instead: the header said the run was still going while everything
    // the run produced afterwards went unseen. The transcript is the one source
    // that still knows, so the pane follows it from there.
    const captured = await stubAgent(page, {
      sessions: [SESSION],
      // Idle when the pane restores (so the composer is a Send), running from
      // the next read on: the turn this pane starts is the one that is still
      // going after its stream dies.
      turnSequence: [false, true],
      // No terminal: the stream just ends, which is what a lost transport is.
      turnEvents: [{ type: "message_start", sessionId: SESSION_KEY }, { type: "agent_thinking", sessionId: SESSION_KEY }],
      historySequence: [
        [{ role: "user", content: "正在跑吗?" }],
        [
          { role: "user", content: "正在跑吗?" },
          { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "exec", arguments: { command: "kubectl get nodes" } }] },
        ],
      ],
    });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();
    await page.locator('[data-od-id="chat-input"]').fill("看看集群");
    await page.locator('[data-od-id="send-btn"]').click();

    // The tool the run went on to make arrives from the transcript, through the
    // follow loop the lost stream handed the turn to.
    await expect(page.locator('[data-od-id="agent-bubble"] [data-od-id="tool-card"]')).toHaveCount(1, {
      timeout: 20_000,
    });
    expect(captured.historyPaths.length).toBeGreaterThan(0);
  });

  test("opens on the assistant, not on a model", async ({ page }) => {
    // The first thing the page showed on a reload was whichever model the
    // gateway listed first — a choice nobody made, and not the object this page
    // is about. The assistant is selected on mount; a model is one click away.
    await stubAgent(page, { sessions: [SESSION], history: HISTORY });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="cp-tab-chat"]').click();

    await expect(page.locator('[data-od-id="obj-cubepilot"]')).toHaveAttribute("aria-pressed", "true");
    // And it is the ASSISTANT's conversation on screen: the greeting's own line
    // is in the thread, which is what selecting it restores.
    await expect(page.locator('[data-od-id="chat-thread"]')).toContainText("上次巡检的结论?");
  });

  test("keeps the AI assistant at the top of the object list", async ({ page }) => {
    // The assistant is one entry; the models are the list that grows. Below them
    // it slid further down with every model added, until reaching the one thing
    // the page exists for meant scrolling for it — so it sits first, where it
    // cannot be scrolled away from.
    await stubAgent(page, { sessions: [SESSION] });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="cp-tab-chat"]').click();

    const order = await page
      .locator('[data-od-id^="obj-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-od-id")));
    expect(order[0]).toBe("obj-cubepilot");
    // And it is still followed by the models, rather than replacing them.
    expect(order.slice(1).some((id) => id !== "obj-cubepilot")).toBe(true);
    // Every one of them is INSIDE the list. Moving the assistant to the top is a
    // splice, and a splice that takes the container's closing tag with it drops
    // the models out of the column they lay out in — the order still reads
    // right while the page does not.
    expect(await page.locator('[data-od-id="object-list"] [data-od-id^="obj-"]').count()).toBe(order.length);
  });

  test("a turn that survived a reload says so, and offers Stop", async ({ page }) => {
    // A turn started elsewhere (or left running across a reload) has no stream
    // in this view, so the only thing that can say it is still going is the
    // server's /turn answer — and Stop is then the only control that ends it.
    await stubAgent(page, { sessions: [SESSION], history: HISTORY, turnActive: true });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();

    await expect(page.locator('[data-od-id="agent-status"]')).toContainText("仍在运行");
    await expect(page.locator('[data-od-id="stop-btn"]')).toBeVisible();
  });

  test("stops a turn that survived a reload, and sends on the settled session", async ({ page }) => {
    // A turn running in another tab, or left running across a reload, has no
    // stream in this view — so Stop is the only control that ends it, and the
    // send that follows has to find the session settled. Against a session whose
    // turn is still running the POST is either refused with a 409 or has its
    // text steered into the running turn and swallowed; the abort must therefore
    // be on the wire BEFORE the message, which is a claim about their order and
    // not about either request alone.
    const captured = await stubAgent(page, { sessions: [SESSION], history: HISTORY, turnActive: true });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();

    await expect(page.locator('[data-od-id="agent-status"]')).toContainText("仍在运行");
    await page.locator('[data-od-id="stop-btn"]').click();

    // The stop landed: the turn is no longer reported as running, so the
    // composer is back to Send and the turn is a normal one to add to.
    await expect(page.locator('[data-od-id="send-btn"]')).toBeVisible();

    await page.locator('[data-od-id="chat-input"]').fill("再巡检一次");
    await page.locator('[data-od-id="send-btn"]').click();
    await expect(page.locator('[data-od-id="chat-thread"]')).toContainText("再巡检一次");

    const posts = captured.agentPosts.map((p) => decodeURIComponent(p));
    expect(posts).toEqual([
      `/api/cubepilot/pilot/api/v1/sessions/${SESSION_KEY}/abort`,
      "/api/cubepilot/pilot/api/v1/messages",
    ]);
  });

  test("a failed turn check says so and offers no Stop", async ({ page }) => {
    await stubAgent(page, { sessions: [SESSION], history: HISTORY, turnCheckFails: true });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();

    await expect(page.locator('[data-od-id="agent-status"]')).toContainText("无法确认");
    // Stop would fail for the same reason the check did, so it is not offered.
    await expect(page.locator('[data-od-id="stop-btn"]')).toHaveCount(0);
    await expect(page.locator('[data-od-id="send-btn"]')).toBeVisible();
  });

  test("renders a turn's narration and tool calls in the order they arrived", async ({ page }) => {
    await stubAgent(page, { sessions: [SESSION], turnEvents: TURN_TOOL_THEN_TEXT });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();
    await page.locator('[data-od-id="chat-input"]').fill("看看集群");
    await page.locator('[data-od-id="send-btn"]').click();

    // The narration that followed the tool must render AFTER the tool card, not
    // above it with every other sentence.
    const bubble = page.locator('[data-od-id="agent-bubble"]').last();
    // Wait for the turn to land first: evaluateAll does not retry, so reading
    // mid-stream would see a shorter list and flake.
    await expect(bubble.locator("[data-od-block]")).toHaveCount(3);
    const order = await bubble.locator('[data-od-block]').evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-od-block")),
    );
    expect(order).toEqual(["text", "tool", "text"]);
  });

  test("a finished tool card collapses, and clicking it opens the output", async ({ page }) => {
    await stubAgent(page, { sessions: [SESSION], turnEvents: TURN_TOOL_THEN_TEXT });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();
    await page.locator('[data-od-id="chat-input"]').fill("看看集群");
    await page.locator('[data-od-id="send-btn"]').click();

    const card = page.locator('[data-od-id="tool-card"]').first();
    await expect(card.locator('[data-od-id="tool-card-head"]')).toHaveAttribute("aria-expanded", "false");
    await expect(card.locator('[data-od-id="tool-output"]')).toHaveCount(0);
    // The command is named on the closed card. The header used to carry only the
    // tool's name, so a reader scanning a thread of `exec` cards had to open each
    // one — and close it again — to find the command behind the output they were
    // looking for.
    await expect(card.locator('[data-od-id="tool-card-command"]')).toHaveText("ceph df");
    await expect(card.locator('[data-od-id="tool-card-head"]')).toContainText("shell");

    await card.locator('[data-od-id="tool-card-head"]').click();
    await expect(card.locator('[data-od-id="tool-output"]')).toContainText("POOL USED");
  });

  test("renders the agent's text as Markdown", async ({ page }) => {
    await stubAgent(page, { sessions: [SESSION], turnEvents: TURN_MARKDOWN });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();
    await page.locator('[data-od-id="chat-input"]').fill("给我一段命令");
    await page.locator('[data-od-id="send-btn"]').click();

    const bubble = page.locator('[data-od-id="agent-bubble"]').last();
    // A fenced block must become a real code element, not literal backticks.
    await expect(bubble.locator("pre")).toContainText("kubectl get pods");
    await expect(bubble).not.toContainText("```");
    // Array form on purpose: a single-string toContainText is dispatched as
    // `to.have.text`, which is strict, and this fixture renders TWO list items —
    // so the single-string form fails with a strict-mode violation rather than a
    // text mismatch, and could never pass.
    await expect(bubble.locator("li")).toContainText(["检查节点", "检查 DevicePlugin"]);
    // A GFM table must become a real table, not its raw pipe syntax. Without
    // remark-gfm it renders as the literal `| 服务 | 状态 |` line — and the
    // agent's inspection answers lead with exactly such a table, so this is the
    // assertion that would have caught the regression.
    await expect(bubble.locator("table")).toContainText("qwen38");
    await expect(bubble.locator("th")).toContainText(["服务", "状态"]);
    await expect(bubble).not.toContainText("| 服务 |");
  });

  test("a pending approval docks above the composer, and lands in the thread once decided", async ({ page }) => {
    await stubAgent(page, { sessions: [SESSION], turnEvents: TURN_APPROVAL });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();
    await page.locator('[data-od-id="chat-input"]').fill("调整 OSD");
    await page.locator('[data-od-id="send-btn"]').click();

    const pending = page.locator('[data-od-id="hitl-dock"] [data-od-id="approval-item"]');
    await expect(pending).toHaveCount(1);
    // Docked: it must live inside the composer region, which does not scroll.
    await expect(page.locator('[data-od-id="hitl-dock"] [data-od-id="approval-approve"]')).toBeVisible();
    // The header reports the parked turn, not the lost transport this fixture
    // also carries: a turn blocked on a human has no terminal event, so the stub
    // ends the stream and the client marks it lost — and "waiting on your
    // approval" has to outrank that. This is the priority chain's acceptance.
    await expect(page.locator('[data-od-id="agent-status"]')).toContainText("等待你的审批");

    await page.locator('[data-od-id="hitl-dock"] [data-od-id="approval-approve"]').click();
    // Decided: it moves into the thread as a record.
    await expect(page.locator('[data-od-id="hitl-dock"] [data-od-id="approval-item"]')).toHaveCount(0);
    const record = page.locator('[data-od-id="agent-bubble"] [data-od-id="approval-item"]');
    await expect(record).toHaveCount(1);

    // A settled card is a RECORD, so it is collapsed to its one-line header and
    // the command is one click away, exactly like a tool card. A card that keeps
    // its full height after it has been decided is a screenful the reader has to
    // scroll past for nothing.
    await expect(record.locator('[data-od-id="approval-command"]')).toHaveCount(0);
    await record.locator('[data-od-id="approval-head"]').click();
    await expect(record.locator('[data-od-id="approval-command"]')).toHaveCount(1);
  });

  test("a settled card sits with the work it permitted, not under the answer", async ({ page }) => {
    // The reference draws the tool log, the resolved cards, then the answer
    // panel. Reversed, the card pushed the conclusion up the screen and read as
    // a footnote to it rather than as part of the work it let through.
    await stubAgent(page, { sessions: [SESSION], turnEvents: TURN_APPROVAL });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();
    await page.locator('[data-od-id="chat-input"]').fill("调整 OSD");
    await page.locator('[data-od-id="send-btn"]').click();
    await page.locator('[data-od-id="hitl-dock"] [data-od-id="approval-approve"]').click();
    await expect(page.locator('[data-od-id="agent-bubble"] [data-od-id="approval-item"]')).toHaveCount(1);

    // Document order is the assertion: the card comes after the tool block it
    // permitted and before the closing text.
    const order = await page
      .locator('[data-od-id="agent-bubble"]')
      .last()
      .evaluate((b) =>
        [...b.querySelectorAll("[data-od-block], [data-od-id='approval-item']")].map(
          (e) => e.getAttribute("data-od-block") ?? "approval",
        ),
      );
    expect(order.indexOf("approval")).toBeGreaterThan(order.indexOf("tool"));
    expect(order.indexOf("approval")).toBeLessThan(order.lastIndexOf("text"));
  });

  test("an approval resolved without a decision reads Stopped, not Rejected", async ({ page }) => {
    // The server publishes `approval_resolved` alongside the terminal, and it
    // carries no `approved` field when nobody decided: the turn ended while the
    // write was parked, which is not the rejection the user never made.
    await stubAgent(page, {
      sessions: [SESSION],
      turnEvents: [...TURN_APPROVAL, { type: "approval_resolved", sessionId: SESSION_KEY, callId: "app-1" }, { type: "message_done", sessionId: SESSION_KEY }],
    });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();
    await page.locator('[data-od-id="chat-input"]').fill("调整 OSD");
    await page.locator('[data-od-id="send-btn"]').click();

    const card = page.locator('[data-od-id="approval-item"]');
    await expect(card).toContainText("已停止");
    await expect(card).not.toContainText("已拒绝");
  });

  test("a question counts down, then withdraws its controls without claiming expiry", async ({ page }) => {
    await stubAgent(page, {
      sessions: [SESSION],
      turnEvents: [
        { type: "message_start", sessionId: SESSION_KEY },
        {
          type: "question_pending",
          sessionId: SESSION_KEY,
          callId: "q-1",
          question: { questions: [{ questionId: "scope", question: "范围?", options: [{ label: "全部" }] }], timeoutSeconds: 2 },
        },
      ],
    });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();
    await page.locator('[data-od-id="chat-input"]').fill("巡检");
    await page.locator('[data-od-id="send-btn"]').click();

    const card = page.locator('[data-od-id="hitl-dock"] [data-od-id="question-item"]');
    await expect(card).toContainText("等待回答");
    // Assert the EXPIRY state first, by its own text. `toBeDisabled` alone is
    // not load-bearing: submit is also disabled until an option is picked, so it
    // would pass on a card with no countdown logic at all. The pill text is what
    // proves the local countdown reached zero, and the pair below is what proves
    // the client did NOT overclaim an expiry only the gateway can declare.
    await expect(card).toContainText("即将超时", { timeout: 5_000 });
    await expect(card.locator('[data-od-id="question-submit"]')).toBeDisabled();
    await expect(card).not.toContainText("已超时");
  });

  test("a refused answer re-reads the pending list and leaves the still-open question answerable", async ({ page }) => {
    // The refusal (409) does not say WHY. Re-reading the pending list is what
    // tells "not accepted" apart from "gone": here the question is still there,
    // so the card reopens with the server's own fresh deadline and the reason
    // on it, and the user can answer again.
    await stubAgent(page, { sessions: [SESSION], turnEvents: TURN_QUESTION, questionPostStatus: 409, pendingQuestionKept: true });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();
    await page.locator('[data-od-id="chat-input"]').fill("巡检");
    await page.locator('[data-od-id="send-btn"]').click();

    const card = page.locator('[data-od-id="hitl-dock"] [data-od-id="question-item"]');
    await expect(card).toContainText("等待回答");
    await card.locator("button").filter({ hasText: "全部节点" }).click();
    await card.locator('[data-od-id="question-submit"]').click();

    await expect(card).toContainText("该回答未被接受");
    await expect(card).not.toContainText("已超时");
    await expect(card.locator('[data-od-id="question-submit"]')).toBeEnabled();
  });

  test("a refused answer against a question the gateway dropped settles as expired", async ({ page }) => {
    // The re-read succeeds and the question is not in the list: that IS the
    // "gone" signal, so the card is over.
    await stubAgent(page, { sessions: [SESSION], turnEvents: TURN_QUESTION, questionPostStatus: 409, pendingQuestionMissing: true });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();
    await page.locator('[data-od-id="chat-input"]').fill("巡检");
    await page.locator('[data-od-id="send-btn"]').click();

    const card = page.locator('[data-od-id="hitl-dock"] [data-od-id="question-item"]');
    await expect(card).toContainText("等待回答");
    await card.locator("button").filter({ hasText: "全部节点" }).click();
    await card.locator('[data-od-id="question-submit"]').click();

    // Settled: the controls are gone and the record moved into the bubble.
    await expect(page.locator('[data-od-id="hitl-dock"] [data-od-id="question-item"]')).toHaveCount(0);
    await expect(page.locator('[data-od-id="agent-bubble"] [data-od-id="question-item"]')).toContainText("已超时");
  });

  test("a re-read that 404s settles the question as expired, not as a refresh failure", async ({ page }) => {
    // This endpoint's 404 is defined as {"error":"no pending question"}, i.e.
    // "the question is not there" — the same "gone" signal as an empty list, and
    // NOT a failed refresh. Reading it as a failure parks the card in pending
    // for the rest of the session behind a retry that can never succeed.
    await stubAgent(page, { sessions: [SESSION], turnEvents: TURN_QUESTION, questionPostStatus: 409, pendingQuestionStatus: 404 });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();
    await page.locator('[data-od-id="chat-input"]').fill("巡检");
    await page.locator('[data-od-id="send-btn"]').click();

    const card = page.locator('[data-od-id="hitl-dock"] [data-od-id="question-item"]');
    await expect(card).toContainText("等待回答");
    await card.locator("button").filter({ hasText: "全部节点" }).click();
    await card.locator('[data-od-id="question-submit"]').click();

    await expect(page.locator('[data-od-id="agent-bubble"] [data-od-id="question-item"]')).toContainText("已超时");
    await expect(page.locator('[data-od-id="hitl-dock"] [data-od-id="question-item"]')).toHaveCount(0);
    await expect(page.locator('[data-od-id="question-item"]')).not.toContainText("无法刷新该问题");
  });

  test("a re-read that fails outright leaves the question answerable, the failure on the card", async ({ page }) => {
    // A 5xx is NOT the "gone" signal: the read failed, so whether the question
    // is still open is simply unknown. This is the conservative branch and the
    // one that matters most — settling on a transient failure would hide the
    // controls while the agent is still parked on the question, leaving the user
    // unable to answer until a reload. So the card stays open with the reason on
    // it, and the answer form stays live.
    await stubAgent(page, { sessions: [SESSION], turnEvents: TURN_QUESTION, questionPostStatus: 409, pendingQuestionStatus: 500 });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="obj-cubepilot"]').click();
    await page.locator('[data-od-id="chat-input"]').fill("巡检");
    await page.locator('[data-od-id="send-btn"]').click();

    const card = page.locator('[data-od-id="hitl-dock"] [data-od-id="question-item"]');
    await expect(card).toContainText("等待回答");
    await card.locator("button").filter({ hasText: "全部节点" }).click();
    await card.locator('[data-od-id="question-submit"]').click();

    await expect(card).toContainText("无法刷新该问题,请重试。");
    await expect(card).not.toContainText("已超时");
    // Still answerable. The pick is load-bearing, not decoration: submit is
    // disabled until an option is picked, so asserting `toBeEnabled` on its own
    // proves nothing about a card whose controls were wrongly withdrawn. Clicking
    // an option only works on a live form (a settled or locked card's options are
    // disabled), and submit turning enabled afterwards is what proves the answer
    // can still be sent.
    await card.locator("button").filter({ hasText: "仅 compute 节点" }).click();
    await expect(card.locator('[data-od-id="question-submit"]')).toBeEnabled();
  });
});

test.describe("cubepilot chat pane (layout)", () => {
  test("drags the resizer to resize the object list column", async ({ page }) => {
    await stubAgent(page);
    await page.goto("/cubepilot");

    const resizer = page.locator('[data-od-id="pane-resizer"]');
    await expect(resizer).toBeVisible();
    const list = page.locator('[data-od-id="object-list"]');

    const colWidth = async (): Promise<number> =>
      list.evaluate((el) => el.getBoundingClientRect().width);
    const before = await colWidth();

    // Drag the resizer ~80px to the right with a real mouse.
    const box = await resizer.boundingBox();
    if (!box) throw new Error("resizer has no bounding box");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 80, y, { steps: 8 });
    await page.mouse.up();

    // The column (and thus the resizer's reported width) grows by ~80px.
    const after = await colWidth();
    expect(after).toBeGreaterThan(before + 50);
  });
});

test.describe("cubepilot config (AgentInstance CR + AgentTemplate catalog)", () => {
  test("shows the instance state, the inherited policy and persists edits", async ({ page }) => {
    const captured = await stubAgent(page);
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="cp-tab-config"]').click();

    const pane = page.locator('[data-od-id="cp-config-pane"]');
    await expect(pane).toBeVisible();

    // Model from the CR; the options are the models the gateway serves.
    // The agent runs them through the platform provider, and the platform
    // prefix stays out of the labels.
    const modelSelect = page.locator('[data-od-id="cp-config-model-select"]');
    await expect(modelSelect).toBeEnabled();
    await expect(modelSelect).toHaveValue("cubestack/qwen38-27b");
    await expect(modelSelect.locator("option")).toHaveCount(2);
    await expect(modelSelect).toContainText("qwen38-27b");
    await expect(modelSelect).toContainText("system-only");
    await expect(page.locator('[data-od-id="cp-config-model-note"]')).toContainText("http://ai-gateway.test:8080/v1");

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

    // LLM 配置: two sources — the gateway catalog (read-only) and your own
    // providers (written to the AgentTemplate, keyed ones through a Secret).
    await expect(page.locator('[data-od-id="cp-config-llm"]')).toBeVisible();
    await expect(page.locator('[data-od-id="cp-config-llm-src-system"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-od-id="cp-config-llm-system"]')).toContainText("system-only");
    await page.locator('[data-od-id="cp-config-llm-src-external"]').click();
    await expect(page.locator('[data-od-id="cp-config-llm-external"]')).toContainText("glm-5.2-chat");
    await expect(page.locator('[data-od-id="cp-config-llm-external"]')).toContainText("密钥");
    // The row reads provider/modelId — the ref an instance selects.
    await expect(page.locator('[data-od-id="cp-config-llm-row"]')).toContainText("glm-5.2-chat/glm-5.2-chat");

    await page.locator('[data-od-id="cp-config-llm-name"]').fill("Local Qwen");
    await page.locator('[data-od-id="cp-config-llm-endpoint"]').fill("http://llm.local:8080/v1/chat/completions");
    await page.locator('[data-od-id="cp-config-llm-models"]').fill("local-qwen-32b, local-qwen-72b");
    await page.locator('[data-od-id="cp-config-llm-public"]').check();
    await page.locator('[data-od-id="cp-config-llm-save"]').click();
    await expect(page.getByText("已添加 provider「Local Qwen」")).toBeVisible();
    expect(captured.llmPosts.at(-1)).toEqual({
      method: "POST",
      path: "/api/cubepilot/agent/llms",
      body: {
        name: "Local Qwen",
        endpoint: "http://llm.local:8080/v1/chat/completions",
        models: ["local-qwen-32b", "local-qwen-72b"],
        public: true,
      },
    });

    // Editing prefills the form; the name is immutable.
    await page.locator('[data-od-id="cp-config-llm-edit"]').first().click();
    await expect(page.locator('[data-od-id="cp-config-llm-name"]')).toBeDisabled();
    await expect(page.locator('[data-od-id="cp-config-llm-models"]')).toHaveValue("glm-5.2-chat");
    await page.locator('[data-od-id="cp-config-llm-endpoint"]').fill("http://gw.test:9090/v1");
    await page.locator('[data-od-id="cp-config-llm-save"]').click();
    await expect(page.getByText("已更新 provider「glm-5.2-chat」")).toBeVisible();
    expect(captured.llmPosts.at(-1)).toMatchObject({
      method: "PUT",
      body: { endpoint: "http://gw.test:9090/v1", models: ["glm-5.2-chat"] },
    });

    // Removing asks for confirmation and deletes by name.
    page.on("dialog", (d) => void d.accept());
    await page.locator('[data-od-id="cp-config-llm-remove"]').first().click();
    await expect(page.getByText("已删除 provider「glm-5.2-chat」")).toBeVisible();
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
    // Picking another served model first: the save carries the new ref.
    await modelSelect.selectOption("cubestack/system-only");
    await page.locator('[data-od-id="cp-config-save"]').click();
    await expect(page.getByText("配置已保存,模型与系统提示词下轮生效")).toBeVisible();
    expect(captured.configPuts.at(-1)).toEqual({
      selectedModel: "cubestack/system-only",
      userInstructions: "巡检优先,写操作全部走审批",
    });
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

  test("keeps the page usable when the template declares no provider", async ({ page }) => {
    await stubAgent(page, { config: { ...CONFIG_READY, selectedModel: "", providers: [], gatewayModels: [] } });
    await page.goto("/cubepilot");
    await page.locator('[data-od-id="cp-tab-config"]').click();

    // No template provider: the page says so instead of failing on a missing
    // gateway, and the model field is an empty, disabled select.
    const pane = page.locator('[data-od-id="cp-config-pane"]');
    await expect(pane).toContainText("模板未声明 provider");
    await page.locator('[data-od-id="cp-config-llm-src-external"]').click();
    await expect(page.locator('[data-od-id="cp-config-llm"]')).toContainText("模板暂未声明外部 provider");
    const modelSelect = page.locator('[data-od-id="cp-config-model-select"]');
    await expect(modelSelect).toBeDisabled();
    await expect(modelSelect.locator("option")).toHaveCount(0);
    await expect(page.locator('[data-od-id="cp-config-prompt-input"]')).toHaveValue("巡检优先,写操作全部走审批");
    await expect(page.locator('[data-od-id="cp-config-status"]')).toContainText("admin-cubepilot");
  });
});
