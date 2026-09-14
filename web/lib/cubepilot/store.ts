// In-memory demo state for the 智能助手 (Copilot) module.
//
// The portal has no agent/LLM backend yet: the /api/cubepilot/* route handlers
// read and mutate the singleton below, seeded with realistic demo data. All
// state is per-process and resets on restart — deliberately, this is a demo
// layer, not storage. A real backend replaces these modules without touching
// the pages (same wire shapes, see lib/cubepilot/types.ts).

import { nextCronRun } from "./cron";
import { buildReply } from "./reply";
import type {
  AgentBlock,
  AgentCall,
  AgentConfig,
  AgentInfo,
  AgentStatus,
  AgentTool,
  AllowlistRule,
  ChatMessage,
  ChatToolCall,
  ConfirmView,
  LlmModel,
  PlaygroundScaling,
  PlaygroundService,
  QuickChip,
  Report,
  SessionInfo,
  SkillInfo,
  Task,
  TaskTemplate,
} from "./types";

/** Simulated duration of a task run before its report materializes. */
const RUN_DURATION_MS = 8_000;

interface Session {
  key: string;
  title?: string;
  messages: ChatMessage[];
}

interface State {
  sessions: Map<string, Session>;
  /** Session order (newest first). */
  sessionOrder: string[];
  tasks: Map<string, Task>;
  taskOrder: string[];
  templates: TaskTemplate[];
  reports: Map<string, Report[]>;
  llms: LlmModel[];
  config: AgentConfig;
  confirm: {
    override: string;
    templatePolicy: string;
    /** Instance-owned rules; platform rules are constants below. */
    owned: AllowlistRule[];
  };
  skills: SkillInfo[];
  /** Instance enabledSkills; empty = all enabled. */
  enabledSkills: string[];
  seq: number;
}

// ── constants ────────────────────────────────────────────────────────────

const PLATFORM_RULES: AllowlistRule[] = [
  { pattern: "kubectl get", label: "kubectl 只读查询", owned: false },
  { pattern: "kubectl describe", label: "kubectl 描述资源", owned: false },
  { pattern: "kubectl logs", label: "kubectl 读取日志", owned: false },
  { pattern: "helm list", label: "Helm 只读查询", owned: false },
  { pattern: "ceph df", label: "Ceph 容量查询", owned: false },
  { pattern: "dcgm dmon", label: "DCGM 指标采集", owned: false },
];

const TEMPLATES: TaskTemplate[] = [
  {
    name: "cluster-inspect",
    displayName: "集群日常巡检",
    description: "节点 / Pod / GPU / 存储 / 证书全量健康检查,输出分级报告",
    instruction:
      "对集群执行全量巡检:节点 Ready 状态与资源压力、非 Running Pod、GPU 温度与显存阈值、Ceph 存储水位、网关 TLS 证书有效期。将发现按 P0(故障)/P1(重要)/P2(提示)分级,并给出处置建议。",
    paramsSchema: [
      { name: "scope", type: "enum", default: "all", enum: ["all", "compute", "inference", "storage"] },
    ],
    defaultCron: "0 6 * * *",
    skills: ["kubectl-platform", "gpu-inspect", "ceph-ops"],
  },
  {
    name: "gpu-health",
    displayName: "GPU 节点健康检查",
    description: "DCGM 指标、温度/显存阈值与 XID 错误扫描",
    instruction:
      "扫描全部 GPU 节点:DCGM 温度/显存/利用率指标、阈值检查(温度 85°C / 显存 90%)、近 24h XID 错误日志。对超阈值 GPU 定位所在节点与业务 Pod,输出分级结论与处置建议。",
    paramsSchema: [{ name: "tempThreshold", type: "number", default: "85" }],
    defaultCron: "0 2 * * *",
    skills: ["gpu-inspect"],
  },
  {
    name: "inference-verify",
    displayName: "推理服务可用性验证",
    description: "对已发布推理服务做端到端探测(P95 延迟 / 错误率)",
    instruction:
      "对 {{namespace}} 下全部 Ready 的 InferenceService 执行端到端验证:经 AI Gateway 发起真实推理请求,统计 P95 延迟与错误率,未通过的服务列出副本状态与最近事件。",
    paramsSchema: [{ name: "namespace", type: "string", default: "default" }],
    defaultCron: "30 8 * * *",
    skills: ["inference-deploy"],
  },
];

// ── seeding ──────────────────────────────────────────────────────────────

function iso(offsetMs: number, base: number): string {
  return new Date(base + offsetMs).toISOString();
}

const H = 3600_000;
const D = 24 * H;

/** Seed the demo state. `now` is injectable for tests. */
export function seedState(now = Date.now()): State {
  const t0 = now;

  const sessions: Map<string, Session> = new Map();
  const sessionOrder: string[] = [];
  const addSession = (key: string, title: string, messages: ChatMessage[]) => {
    sessions.set(key, { key, title, messages });
    sessionOrder.push(key);
  };

  addSession("agent:main-gpu-temp-0826", "GPU 温度告警排查", [
    { role: "user", text: "gpu-nvidia-02 的 GPU#3 温度偏高,帮我看看原因" },
    {
      role: "assistant",
      tools: [
        { name: "dcgm", cmd: "dcgm dmon -e 154,155,203 -d 1000", result: "GPU#3 Temp 87°C (阈值 85°C) · Util 96% · Mem 91%" },
        { name: "ipmitool", cmd: "ipmitool -H compute-02-bmc sensor list | grep -i fan", result: "Fan#2 4200 RPM (lower non-critical, 05:41 起)" },
      ],
      text: "**结论:GPU#3 温度 87°C 的直接原因是风扇 #2 转速异常(4200 RPM,应 ≥ 6800 RPM),叠加该卡的高负载推理副本。**\n\n建议:下发功率封顶 180W + 创建风扇更换工单。已生成处置 Workflow,等待你的审批。",
    },
  ]);

  addSession("agent:main-cluster-0825", "集群巡检结论", [
    { role: "user", text: "昨天巡检的结论再帮我总结一下" },
    {
      role: "assistant",
      tools: [{ name: "workflow", cmd: "read report inspect-0825", result: "24/26 通过 · 异常 2 项" }],
      text: "**昨日巡检(策略 daily-6am):24 / 26 项通过。**\n\n1. osd-07 使用率 82%,预计 9 天后触及 90% 告警线 → 建议 PG 均衡\n2. gpu-nvidia-02 GPU#3 温度超阈值 → 已转入 GPU 健康检查任务跟踪\n\n其余控制面 / 网络 / 推理服务 / 证书均正常。",
    },
  ]);

  addSession("agent:main-isvc-0824", "推理服务扩容咨询", [
    { role: "user", text: "glm-5.2-chat 想扩到 4 副本,资源够吗?" },
    {
      role: "assistant",
      tools: [{ name: "kubectl", cmd: "kubectl get isvc glm-5.2-chat -o yaml | grep -A5 replicas", result: "replicas: 2 · gpuPerPod: 1 · 推理池空闲 GPU: 3" }],
      text: "当前推理池空闲 3 张 GPU,扩到 4 副本需要 2 张,**资源足够**。确认扩容吗?我会经 controller 滚动生效,不中断已有请求。",
    },
    { role: "user", text: "好,执行吧" },
    { role: "assistant", text: "已提交扩容(InferenceService overrides.replicas=2→4)。**等待审批** · 审批人:你 · 生效后我会自动验证 P95 延迟。" },
  ]);

  const tasks: Map<string, Task> = new Map();
  const taskOrder: string[] = [];
  const reports: Map<string, Report[]> = new Map();
  let seq = 0;
  const nid = (prefix: string) => `${prefix}-${(++seq).toString(36)}`;

  const addTask = (
    task: Omit<Task, "id">,
    reportList: Array<Omit<Report, "id" | "taskId" | "taskName">>,
  ): Task => {
    const t: Task = { ...task, id: nid("task") };
    tasks.set(t.id, t);
    taskOrder.push(t.id);
    reports.set(
      t.id,
      reportList.map((r) => ({ ...r, id: nid("run"), taskId: t.id, taskName: t.name })),
    );
    return t;
  };

  const dailyInspectionReport = (when: number, p1: number, p2: number): Omit<Report, "id" | "taskId" | "taskName"> => ({
    trigger: "Cron",
    status: "success",
    startedAt: iso(when, t0),
    finishedAt: iso(when + 4 * 60_000, t0),
    content: [
      "# 集群日常巡检报告",
      "",
      `**范围**: all · **策略**: daily-6am`,
      "",
      "## 检查项",
      "- Kubernetes 控制面: ✅ API Server / etcd / Scheduler / Controller 4/4",
      "- Node Ready: ✅ 16 节点 Ready,无 CrashLoopBackOff",
      "- GPU 健康: ⚠️ gpu-nvidia-02 GPU#3 温度 87°C > 85°C(P1)",
      "- 存储容量: ⚠️ osd-07 使用率 82%(P1)",
      "- 网络组件: ✅ Cilium / Envoy Gateway / CoreDNS 2/2",
      "- 推理服务: ✅ 11 就绪 · qwen2.5-72b 扩缩容中(P2)",
      "- 证书与安全: ✅ 网关 TLS 证书 28 天后到期(P2)",
      "",
      "## 结论",
      `**24 / 26 项通过** · P0: 0 · P1: ${p1} · P2: ${p2} · 异常已同步消息中心`,
    ].join("\n"),
    p0: 0,
    p1,
    p2,
  });

  addTask(
    {
      name: "每日集群巡检",
      prompt: "",
      schedule: "0 6 * * *",
      templateRef: "cluster-inspect",
      enabled: true,
      creator: "platform",
      createdAt: iso(-14 * D, t0),
      lastRunAt: iso(-1 * D + 6 * H, t0),
      lastStatus: "success",
      nextRunAt: (nextCronRun("0 6 * * *", new Date(t0)) ?? undefined)?.toISOString(),
    },
    [dailyInspectionReport(-2 * D + 6 * H, 1, 2), dailyInspectionReport(-1 * D + 6 * H, 2, 2)],
  );

  addTask(
    {
      name: "GPU 节点健康检查",
      prompt: "",
      schedule: "0 2 * * *",
      templateRef: "gpu-health",
      enabled: true,
      creator: "platform",
      createdAt: iso(-14 * D, t0),
      lastRunAt: iso(-1 * D + 2 * H, t0),
      lastStatus: "success",
      nextRunAt: (nextCronRun("0 2 * * *", new Date(t0)) ?? undefined)?.toISOString(),
    },
    [
      {
        trigger: "Cron",
        status: "success",
        startedAt: iso(-1 * D + 2 * H, t0),
        finishedAt: iso(-1 * D + 2 * H + 42_000, t0),
        content: [
          "# GPU 节点健康检查报告",
          "",
          "## 扫描范围",
          "- 3 个 GPU 池 · 128 张卡(NVIDIA ×96 / MetaX ×32)",
          "",
          "## 阈值检查(温度 85°C / 显存 90%)",
          "- ⚠️ gpu-nvidia-02 GPU#3: 温度 87°C(P1)· 关联告警 P2-8841",
          "- 其余 127 张卡正常(71–78°C)",
          "",
          "## XID 错误(近 24h)",
          "- 无 Xid 48 / 63 / 79 记录",
          "",
          "## 结论",
          "**1 项异常** · P0: 0 · P1: 1 · P2: 0 · 已推送消息中心",
        ].join("\n"),
        p0: 0,
        p1: 1,
        p2: 0,
      },
    ],
  );

  addTask(
    {
      name: "推理服务可用性验证",
      prompt: "",
      schedule: "30 8 * * *",
      templateRef: "inference-verify",
      enabled: true,
      creator: "platform",
      createdAt: iso(-7 * D, t0),
      lastRunAt: iso(-1 * D + 8 * H + 30 * 60_000, t0),
      lastStatus: "success",
      nextRunAt: (nextCronRun("30 8 * * *", new Date(t0)) ?? undefined)?.toISOString(),
    },
    [
      {
        trigger: "Cron",
        status: "success",
        startedAt: iso(-1 * D + 8 * H + 30 * 60_000, t0),
        finishedAt: iso(-1 * D + 8 * H + 32 * 60_000, t0),
        content: [
          "# 推理服务可用性验证报告",
          "",
          "## 验证结果(经 AI Gateway 端到端)",
          "| 服务 | 副本 | P95 | 结果 |",
          "| --- | --- | --- | --- |",
          "| glm-5.2-chat | 2/2 | 412ms | ✅ 通过 |",
          "| deepseek-v4 | 2/2 | 388ms | ✅ 通过 |",
          "| qwen2.5-72b | 1/2 | — | ⏳ 扩缩容完成后重试 |",
          "",
          "## 结论",
          "**2 / 3 服务通过** · P0: 0 · P1: 0 · P2: 1",
        ].join("\n"),
        p0: 0,
        p1: 0,
        p2: 1,
      },
    ],
  );

  addTask(
    {
      name: "升级前预检(v1.4.0)",
      prompt: "校验 v1.3.2 → v1.4.0 升级路径、etcd 碎片率与备份、容量水位、CRD 兼容性,输出预检结论",
      schedule: "",
      enabled: false,
      creator: "platform",
      createdAt: iso(-3 * D, t0),
      lastRunAt: iso(-2 * D + 22 * H, t0),
      lastStatus: "failed",
    },
    [
      {
        trigger: "Manual",
        status: "failed",
        startedAt: iso(-2 * D + 22 * H, t0),
        finishedAt: iso(-2 * D + 22 * H + 82_000, t0),
        content: [
          "# 升级前预检报告(v1.3.2 → v1.4.0)",
          "",
          "## 预检项",
          "- 版本升级路径: ✅ 合法",
          "- etcd 碎片率: ⚠️ 31%(建议 compact + defrag)",
          "- Ceph 容量: ⚠️ 78%(warning)",
          "- CRD 兼容性: ✅ ai.cubestack.io/v1alpha1 兼容",
          "",
          "## 结论",
          "**失败**: 预检脚本在 CRD 兼容性扫描阶段超时(> 60s)。12 项通过,2 项 warning。请调整超时或分批扫描后重试。",
        ].join("\n"),
        p0: 0,
        p1: 2,
        p2: 0,
      },
    ],
  );

  const skills: SkillInfo[] = [
    { name: "kubectl-platform", displayName: "K8s 平台操作", description: "节点 / Pod / Service / 自定义资源的只读查询与受控写操作", enabled: true },
    { name: "gpu-inspect", displayName: "GPU 巡检", description: "DCGM 指标采集、温度/显存阈值与 XID 错误扫描", enabled: true },
    { name: "inference-deploy", displayName: "推理服务", description: "InferenceService 查询、扩缩容与发布验证", enabled: true },
    { name: "devenv-ops", displayName: "开发环境运维", description: "DevEnvironment 启停、连接信息与规格调整", enabled: false },
    { name: "ceph-ops", displayName: "存储运维", description: "Ceph 容量、PG 均衡与 OSD 诊断", enabled: true },
    { name: "log-collect", displayName: "日志采集", description: "按命名空间/节点聚合日志并归档至对象存储", enabled: false },
  ];

  return {
    sessions,
    sessionOrder,
    tasks,
    taskOrder,
    templates: TEMPLATES,
    reports,
    llms: [
      { name: "glm-5.2-chat", endpoint: "https://llm.cubestack.local/v1", keyed: true },
      { name: "qwen2.5-72b", endpoint: "https://llm.cubestack.local/v1/qwen", keyed: true },
      { name: "deepseek-v4", endpoint: "https://api.deepseek.com/v1", keyed: true },
    ],
    config: {
      exists: true,
      model: "glm-5.2-chat",
      systemPrompt:
        "你是 CubeStack 智算云平台的智能助手 CubePilot。通过统一工具接口访问 Kubernetes / GPU 集群 / 推理服务 / 存储。回答使用中文,结论先行,给出依据与可执行的处置建议;写操作必须先经用户审批。",
    },
    confirm: {
      override: "Allowlist",
      templatePolicy: "Allowlist",
      owned: [{ pattern: "helm upgrade", argPattern: "ai-gateway.*", owned: true }],
    },
    skills,
    enabledSkills: skills.filter((s) => s.enabled).map((s) => s.name),
    seq,
  };
}

// ── singleton ────────────────────────────────────────────────────────────

let state: State = seedState();

/** Test hook: re-seed the singleton with an injectable clock. */
export function __resetStore(now = Date.now()): void {
  state = seedState(now);
}

function nextId(prefix: string): string {
  return `${prefix}-${(++state.seq).toString(36)}`;
}

/** Materialize simulated runs whose duration has elapsed. */
function materializeRuns(): void {
  const now = Date.now();
  for (const list of state.reports.values()) {
    for (const r of list) {
      if (r.status !== "running") continue;
      if (now - new Date(r.startedAt).getTime() >= RUN_DURATION_MS) {
        finishRun(r);
      }
    }
  }
}

function finishRun(r: Report): void {
  r.status = "success";
  r.finishedAt = new Date().toISOString();
  const task = state.tasks.get(r.taskId);
  const template = task?.templateRef ? state.templates.find((t) => t.name === task.templateRef) : undefined;
  const prompt = template?.instruction ?? task?.prompt ?? "执行任务";
  const findings = countFindings(reportForTemplate(template?.name, prompt));
  r.content = findings.md;
  r.p0 = findings.p0;
  r.p1 = findings.p1;
  r.p2 = findings.p2;
  if (task) {
    task.lastRunAt = r.startedAt;
    task.lastStatus = r.status;
  }
}

interface Findings {
  md: string;
  p0: number;
  p1: number;
  p2: number;
}

/** Extract P0/P1/P2 counts from the "P0: n · P1: n · P2: n" conclusion line. */
function countFindings(content: string): Findings {
  const m = /P0:\s*(\d+)\s*·\s*P1:\s*(\d+)\s*·\s*P2:\s*(\d+)/.exec(content);
  return {
    md: content,
    p0: m ? Number(m[1]) : 0,
    p1: m ? Number(m[2]) : 0,
    p2: m ? Number(m[3]) : 0,
  };
}

/** Canned report content for a just-finished (simulated) run. */
function reportForTemplate(templateName: string | undefined, prompt: string): string {
  const stamp = new Date().toISOString();
  if (templateName === "cluster-inspect") {
    return [
      "# 集群日常巡检报告",
      "",
      `**运行时间**: ${stamp} · **范围**: all`,
      "",
      "## 检查项",
      "- Kubernetes 控制面: ✅ 4/4",
      "- Node Ready: ✅ 16 节点 Ready,无 CrashLoopBackOff",
      "- GPU 健康: ⚠️ gpu-nvidia-02 GPU#3 温度 87°C > 85°C(P1)",
      "- 存储容量: ⚠️ osd-07 使用率 82%(P1)",
      "- 网络组件: ✅ 2/2",
      "- 推理服务: ✅ 11 就绪(P2: qwen2.5-72b 扩缩容中)",
      "- 证书与安全: ✅ 正常(P2: 证书 28 天后到期)",
      "",
      "## 结论",
      "**24 / 26 项通过** · P0: 0 · P1: 2 · P2: 2 · 异常已同步消息中心",
    ].join("\n");
  }
  if (templateName === "gpu-health") {
    return [
      "# GPU 节点健康检查报告",
      "",
      `**运行时间**: ${stamp}`,
      "",
      "## 阈值检查(温度 85°C / 显存 90%)",
      "- ⚠️ gpu-nvidia-02 GPU#3: 温度 87°C(P1)",
      "- 其余 127 张卡正常",
      "",
      "## XID 错误(近 24h)",
      "- 无 Xid 48 / 63 / 79 记录",
      "",
      "## 结论",
      "**1 项异常** · P0: 0 · P1: 1 · P2: 0",
    ].join("\n");
  }
  if (templateName === "inference-verify") {
    return [
      "# 推理服务可用性验证报告",
      "",
      `**运行时间**: ${stamp}`,
      "",
      "## 验证结果(经 AI Gateway 端到端)",
      "- glm-5.2-chat: ✅ 通过 · P95 412ms",
      "- deepseek-v4: ✅ 通过 · P95 388ms",
      "- qwen2.5-72b: ⏳ 扩缩容中,验证推迟(P2)",
      "",
      "## 结论",
      "**2 / 3 服务通过** · P0: 0 · P1: 0 · P2: 1",
    ].join("\n");
  }
  return [
    "# 任务执行报告(自由任务)",
    "",
    `**运行时间**: ${stamp}`,
    "",
    "## 指令",
    "```",
    prompt,
    "```",
    "",
    "## 执行摘要",
    "- 已按计划完成资源查询与状态核对",
    "- ⚠️ osd-07 使用率 82%,建议关注(P1)",
    "- 其余指标正常",
    "",
    "## 结论",
    "**执行成功** · P0: 0 · P1: 1 · P2: 0",
  ].join("\n");
}

// ── sessions ─────────────────────────────────────────────────────────────

export function listSessions(): SessionInfo[] {
  return state.sessionOrder.map((key) => {
    const s = state.sessions.get(key)!;
    return { sessionKey: key, title: s.title };
  });
}

/** Create an empty session; returns its key. */
export function createSession(): string {
  const key = `agent:main-${nextId("s")}`;
  state.sessions.set(key, { key, messages: [] });
  state.sessionOrder.unshift(key);
  return key;
}

export function getSession(key: string): Session | undefined {
  return state.sessions.get(key);
}

export function listMessages(key: string): ChatMessage[] {
  return state.sessions.get(key)?.messages ?? [];
}

/**
 * Append a user message plus the simulated assistant reply. Returns the
 * reply. The session title is derived from the first user message.
 */
export function sendUserMessage(key: string, text: string): AssistantReplyResult {
  const s = state.sessions.get(key);
  if (!s) return { key, reply: null };
  s.messages.push({ role: "user", text });
  if (!s.title) s.title = text.length > 24 ? text.slice(0, 24) + "…" : text;
  const reply = buildReply(text);
  s.messages.push({ role: "assistant", text: reply.text, tools: reply.tools });
  return { key, reply };
}

export interface AssistantReplyResult {
  key: string;
  reply: { text: string; tools?: ChatToolCall[] } | null;
}

// ── tasks ────────────────────────────────────────────────────────────────

/** Reports for a task, with expired simulated runs materialized. */
export function listReports(taskId: string): Report[] {
  materializeRuns();
  return [...(state.reports.get(taskId) ?? [])].reverse();
}

export function listTasks(): Task[] {
  materializeRuns();
  return state.taskOrder
    .map((id) => state.tasks.get(id)!)
    .map((t) => {
      // Recompute nextRunAt so it always lies in the future.
      const next = t.schedule ? nextCronRun(t.schedule, new Date()) : null;
      return { ...t, nextRunAt: next?.toISOString() };
    });
}

export function getTask(id: string): Task | undefined {
  return state.tasks.get(id);
}

export interface CreateTaskInput {
  name: string;
  prompt: string;
  schedule: string;
  templateRef?: string;
  params?: Record<string, string>;
}

export function createTask(user: string, input: CreateTaskInput): Task {
  const template = input.templateRef ? state.templates.find((t) => t.name === input.templateRef) : undefined;
  const instruction = template
    ? renderInstruction(template.instruction, input.params ?? {})
    : input.prompt.trim();
  const schedule = input.schedule.trim();
  const task: Task = {
    id: nextId("task"),
    name: input.name.trim(),
    prompt: template ? "" : instruction,
    schedule,
    templateRef: template?.name,
    enabled: true,
    creator: user,
    createdAt: new Date().toISOString(),
  };
  if (schedule) task.nextRunAt = nextCronRun(schedule, new Date())?.toISOString();
  state.tasks.set(task.id, task);
  state.taskOrder.push(task.id);
  state.reports.set(task.id, []);
  return task;
}

/** Interpolate {{param}} placeholders (client preview does the same). */
export function renderInstruction(instruction: string, params: Record<string, string>): string {
  let out = instruction;
  for (const [k, v] of Object.entries(params)) {
    out = out.split("{{" + k + "}}").join(v);
  }
  return out;
}

export function deleteTask(id: string): boolean {
  if (!state.tasks.delete(id)) return false;
  state.taskOrder = state.taskOrder.filter((x) => x !== id);
  state.reports.delete(id);
  return true;
}

export function toggleTask(id: string): Task | undefined {
  const t = state.tasks.get(id);
  if (!t) return undefined;
  t.enabled = !t.enabled;
  return t;
}

/** Start a simulated run; the report materializes after RUN_DURATION_MS. */
export function runTask(id: string, trigger: "Cron" | "Manual"): Report | undefined {
  const t = state.tasks.get(id);
  if (!t) return undefined;
  const startedAt = new Date().toISOString();
  const report: Report = {
    id: nextId("run"),
    taskId: id,
    taskName: t.name,
    trigger,
    status: "running",
    startedAt,
    finishedAt: "",
    content: "",
    p0: 0,
    p1: 0,
    p2: 0,
  };
  const list = state.reports.get(id) ?? [];
  list.push(report);
  state.reports.set(id, list);
  t.lastRunAt = startedAt;
  t.lastStatus = "running";
  return report;
}

export function listTemplates(): TaskTemplate[] {
  return state.templates;
}

// ── LLMs ─────────────────────────────────────────────────────────────────

export function listLlms(): LlmModel[] {
  return state.llms;
}

export function addLlm(model: { name: string; endpoint: string; keyed: boolean }): { ok: boolean; error?: string } {
  const name = model.name.trim();
  if (!name) return { ok: false, error: "name required" };
  if (!model.endpoint.trim()) return { ok: false, error: "endpoint required" };
  if (state.llms.some((m) => m.name === name)) return { ok: false, error: `model "${name}" already exists` };
  state.llms.push({ name, endpoint: model.endpoint.trim(), keyed: model.keyed });
  return { ok: true };
}

export function updateLlm(
  name: string,
  patch: { endpoint?: string; keyed?: boolean },
): { ok: boolean; error?: string } {
  const m = state.llms.find((x) => x.name === name);
  if (!m) return { ok: false, error: `model "${name}" not found` };
  if (patch.endpoint !== undefined) m.endpoint = patch.endpoint.trim() || m.endpoint;
  if (patch.keyed !== undefined) m.keyed = patch.keyed;
  return { ok: true };
}

export function deleteLlm(name: string): { ok: boolean; error?: string } {
  if (state.config.model === name) {
    return { ok: false, error: `model "${name}" is selected by your instance` };
  }
  const i = state.llms.findIndex((m) => m.name === name);
  if (i === -1) return { ok: false, error: `model "${name}" not found` };
  state.llms.splice(i, 1);
  return { ok: true };
}

// ── agent config / status / confirm / skills ─────────────────────────────

export function getConfig(): AgentConfig {
  return state.config;
}

export function saveConfig(patch: { model?: string; systemPrompt?: string }): AgentConfig {
  if (patch.model !== undefined) state.config.model = patch.model;
  if (patch.systemPrompt !== undefined) state.config.systemPrompt = patch.systemPrompt;
  return state.config;
}

export function getStatus(user: string): AgentStatus {
  const startedAt = new Date(Date.now() - 2 * D - 5 * H).toISOString();
  return {
    exists: state.config.exists,
    id: `agent-${user}`,
    phase: "Ready",
    startedAt,
    uptimeSeconds: 2 * 24 * 3600 + 5 * 3600,
    gatewayImage: "cubestack/cubepilot-gateway:v1.4.0",
    user,
  };
}

export function getConfirm(): ConfirmView {
  const owned = state.confirm.owned.map((r) => ({ ...r }));
  const inherited = PLATFORM_RULES.filter(
    (p) => !owned.some((o) => o.pattern === p.pattern),
  ).map((r) => ({ ...r }));
  return {
    exists: state.config.exists,
    confirmPolicy: state.confirm.override || state.confirm.templatePolicy,
    templatePolicy: state.confirm.templatePolicy,
    override: state.confirm.override,
    allowlist: [...owned, ...inherited],
    channel: "up",
  };
}

export function saveConfirm(body: { confirmPolicy?: string; allowlist?: AllowlistRule[] }): ConfirmView {
  if (body.confirmPolicy !== undefined) {
    state.confirm.override = body.confirmPolicy;
  }
  if (body.allowlist !== undefined) {
    // The body carries the full desired list; rules marked owned replace the
    // instance state, platform rules are dropped back to the template default.
    state.confirm.owned = body.allowlist.filter((r) => r.owned);
  }
  return getConfirm();
}

export function listSkills(): SkillInfo[] {
  const enabled = state.enabledSkills;
  const allOn = enabled.length === 0;
  return state.skills.map((s) => ({ ...s, enabled: allOn || enabled.includes(s.name) }));
}

export function setSkillEnabled(name: string, enable: boolean): SkillInfo[] {
  const s = state.skills.find((x) => x.name === name);
  if (!s) return listSkills();
  const set = new Set(state.enabledSkills);
  if (enable) set.add(name);
  else set.delete(name);
  state.enabledSkills = [...set];
  return listSkills();
}

// ── playground (inference services) ──────────────────────────────────────

/**
 * Demo catalog of running inference services for the unified chat object
 * list, mirroring public/chat.html. Static on purpose: the demo does not
 * mutate service state.
 */
const PLAYGROUND_SERVICES: PlaygroundService[] = [
  {
    serviceId: "glm-5.2-chat",
    name: "glm-5.2-chat",
    engine: "vLLM",
    gpu: "2 × A100(NVIDIA)",
    model: "GLM-5.2 · v1.0.0",
    replicas: "2 / 4",
    qps: 42,
    p95Ms: 412,
    tps: 1204,
    persona: "我是 GLM-5.2,由 CubeStack 推理池以 vLLM 引擎托管,当前张量并行 TP=2。",
  },
  {
    serviceId: "deepseek-v4",
    name: "deepseek-v4",
    engine: "SGLang",
    gpu: "4 × C500(沐曦)",
    model: "DeepSeek-V4 · v0.9.2",
    replicas: "4 / 6",
    qps: 67,
    p95Ms: 388,
    tps: 2310,
    persona: "我是 DeepSeek-V4,运行在沐曦 C500 推理池,由 SGLang 引擎提供服务。",
  },
  {
    serviceId: "llama3-8b-chat",
    name: "llama3-8b-chat",
    engine: "vLLM",
    gpu: "1 × A100(NVIDIA)",
    model: "Llama-3-8B · v1.2.0",
    replicas: "1 / 2",
    qps: 18,
    p95Ms: 196,
    tps: 640,
    persona: "我是 Llama-3-8B 微调版,单卡 A100 部署,适合低并发调试与验证。",
  },
];

/** Services still scaling; they join the list once ready. */
const PLAYGROUND_SCALING: PlaygroundScaling[] = [{ name: "qwen2.5-72b", engine: "GPUStack" }];

/** Scripted model answers, rotated by turn; {placeholders} fill service facts. */
const PLAYGROUND_REPLIES = [
  "好的。这个请求已通过 AI Gateway 路由到 {name} 后端。当前副本数 {replicas},KV Cache 使用率 61%,请求队列无积压。如需更高吞吐,可以把 maxReplicas 上调,或在低峰期开启模型预热以减少冷启动。",
  "收到。在 CubeStack 上,这类任务建议拆成两步:先在开发环境(DevEnvironment)里用小样本验证,再把推理服务的最小副本数固定为 2 保证可用性。{name} 当前 P95 延迟 {latency}ms,处于健康区间。",
  "这是一个演示回复:{name} 由 {engine} 引擎托管,GPU 规格 {gpu}。平台按 token_throughput 与 queue_size 指标自动扩缩容,扩容稳定窗 60s、缩容稳定窗 300s。",
];

export function listPlaygroundServices(): {
  services: PlaygroundService[];
  scaling: PlaygroundScaling[];
} {
  return {
    services: PLAYGROUND_SERVICES.map((s) => ({ ...s })),
    scaling: PLAYGROUND_SCALING.map((s) => ({ ...s })),
  };
}

/**
 * The deterministic demo "inference": rotates the scripted replies by turn
 * and fills them with the selected service's facts. Null for unknown ids.
 */
export function playgroundChat(serviceId: string, turn: number): string | null {
  const svc = PLAYGROUND_SERVICES.find((s) => s.serviceId === serviceId);
  if (!svc) return null;
  const idx = ((turn % PLAYGROUND_REPLIES.length) + PLAYGROUND_REPLIES.length) % PLAYGROUND_REPLIES.length;
  return PLAYGROUND_REPLIES[idx]
    .replace("{name}", svc.name)
    .replace("{engine}", svc.engine)
    .replace("{gpu}", svc.gpu)
    .replace("{replicas}", svc.replicas)
    .replace("{latency}", String(svc.p95Ms));
}

// ── unified chat: agent (CubePilot) demo content ──────────────────────────

/**
 * Static demo content for the agent object and its context rail, mirroring
 * public/chat.html. Consumed client-side (no route): it is presentation
 * data, never mutated.
 */
const AGENT_INFO: AgentInfo = {
  id: "cubepilot",
  name: "CubePilot",
  role: "智能运维 Agent",
  heartbeat: 12,
  ro: 34,
  rw: 8,
};

const AGENT_TOOLS: AgentTool[] = [
  { name: "kubectl.get / describe", scope: "ro" },
  { name: "kubectl.logs / events", scope: "ro" },
  { name: "prometheus.query", scope: "ro" },
  { name: "dcgm.metrics", scope: "ro" },
  { name: "ipmi.sensor", scope: "ro" },
  { name: "ceph.df / osd tree", scope: "ro" },
  { name: "ceph.pg.stat", scope: "ro" },
  { name: "smartctl", scope: "ro" },
  { name: "kubectl.scale replicas", scope: "rw" },
  { name: "kubectl.delete pod", scope: "rw" },
  { name: "ceph.reweight-by-utilization", scope: "rw" },
  { name: "dcgm.power-cap", scope: "rw" },
  { name: "workflow.create", scope: "rw" },
  { name: "tls.cert-renew", scope: "rw" },
];

const AGENT_CALLS: AgentCall[] = [
  { time: "09:41:22", tool: "ceph.df", scope: "ro" },
  { time: "09:41:21", tool: "ceph.pg.stat", scope: "ro" },
  { time: "09:41:19", tool: "smartctl", scope: "ro" },
  { time: "09:38:05", tool: "ipmi.sensor", scope: "ro" },
  { time: "09:38:02", tool: "dcgm.metrics", scope: "ro" },
  { time: "09:36:47", tool: "workflow.create", scope: "rw" },
];

const AGENT_GREETING: AgentBlock[] = [
  { p: "你好,我是 CubePilot。已接入 Kubernetes、GPUStack 与监控 API(只读工具 34 项,写工具 8 项需审批)。" },
  { p: "今日 06:00 巡检发现 2 项异常:Ceph osd-07 容量与 compute-02 GPU 温度。可点击上方快捷问题直接分析。" },
  { meta: "会话审计已开启 · 写操作将记录并进入审批队列" },
];

const AGENT_SCENARIOS: Record<string, AgentBlock[]> = {
  ceph: [
    { p: "结论:osd-07 使用率 82% 由 PG 分布倾斜叠加近一周数据增长引起,预计 9 天后触及 90% 告警戒线。依据:" },
    { p: "· osd-07 承载 214 个 PG,高于集群均值 168(+27%)" },
    { p: "· 近 7 天日均增长 2.1%,主要来自 cube-storage 池训练 Checkpoint" },
    { p: "· SMART 与磁盘健康检查正常,非硬件故障" },
    { cmd: "ceph osd df tree | grep osd.7\nceph pg stat" },
    {
      actions: [
        {
          label: "执行只读诊断",
          doneLabel: "已执行",
          primary: true,
          results: [
            {
              out: "NAME    USED   AVAIL   VAR   PGS\nosd.7   1.6Ti  380Gi   1.27  214\nosd.3   1.1Ti  890Gi   0.94  161\nosd.11  1.2Ti  810Gi   0.98  170\n\npgs: 4096 active+clean · 0 degraded · 0 undersized",
            },
            { p: "诊断确认数据面健康。处置建议:1) ceph osd reweight-by-utilization 均衡 PG;2) 或在本周窗口内新增 osd-13 扩容 1.8Ti。" },
          ],
        },
        {
          label: "创建扩容预案 Workflow",
          doneLabel: "已创建",
          results: [
            { p: "已创建 Workflow「pvc-expand-osd07」并进入待审批队列(审批人:张)。内容:新增 osd-13 · +1.8Ti · 计划窗口 周六 02:00。" },
          ],
        },
      ],
    },
    { meta: "CubePilot · 调用工具: ceph.df / pg.stat / smartctl · 只读" },
  ],
  "gpu-temp": [
    { p: "结论:compute-02 GPU#3 温度 87°C 的直接原因是机箱风扇 #2 转速异常(4200 RPM,应 ≥ 6800 RPM),叠加该卡承载的高负载验证任务。" },
    { p: "· 同机其他 7 卡 71–78°C,机柜进风 24°C 正常,排除机房制冷问题" },
    { p: "· IPMI 自 05:41 起报 Fan#2 lower non-critical,与温升曲线吻合" },
    { p: "· 该卡利用率 96%、显存 91%,业务侧无报错,暂无紧急迁移必要" },
    { cmd: "ipmitool -H compute-02-bmc sensor list | grep -i fan" },
    {
      actions: [
        {
          label: "下发功率封顶(180W)",
          doneLabel: "已下发",
          primary: true,
          results: [
            { p: "已通过 DCGM 下发功率封顶 180W,GPU#3 频率将自动回落,预计 10 分钟内降至 80°C 以下。同时已创建风扇更换工单 #OPS-2201(24h 内处理)。" },
          ],
        },
        {
          label: "仅观察,不处理",
          doneLabel: "已标记观察",
          results: [
            { p: "已标记为观察项:若 GPU#3 温度 30 分钟内仍 > 85°C,将自动迁移该卡上的推理副本并再次通知你。" },
          ],
        },
      ],
    },
    { meta: "CubePilot · 调用工具: ipmi.sensor / dcgm.metrics · 只读 + 1 项写操作待确认" },
  ],
  "pre-upgrade": [
    { p: "已基于「升级前预检」Workflow 的规则生成结论:v1.3.2 → v1.4.0 路径合法,12 项通过、2 项 warning,可以升级。" },
    { p: "· warning 1:etcd 碎片率 31%,升级前建议执行 compact + defrag" },
    { p: "· warning 2:Ceph 容量 78%,建议先处理 osd-07 的 P1 告警再择期升级" },
    {
      actions: [
        {
          label: "创建升级执行计划",
          doneLabel: "已创建",
          primary: true,
          results: [
            { p: "已生成升级执行计划并进入审批队列(审批人:张)。建议窗口:周日 02:00–04:00。可在「智能助手 CubePilot → 自动化 Workflow」跟踪进度。" },
          ],
        },
      ],
    },
    { meta: "CubePilot · 引用 Workflow: pre-upgrade-check" },
  ],
};

const AGENT_GENERIC: AgentBlock[] = [
  { p: "收到。当前会话接入的是演示数据,我可以回答巡检结果、告警根因与运维操作相关问题;所有写操作(重建、扩容、降频)都会先生成执行计划并要求审批。" },
  { p: "可以试试上方三个示例问题,或在「智能助手 CubePilot」页查看完整巡检与审批队列。" },
  { meta: "CubePilot · glm-5.2-chat · 工具白名单 42 项" },
];

const MODEL_CHIPS: QuickChip[] = [
  { label: "temperature 应该怎么调?" },
  { label: "介绍一下你的部署规格" },
  { label: "如何提升吞吐?" },
];

const AGENT_CHIPS: QuickChip[] = [
  { label: "分析 Ceph OSD 使用率告警", key: "ceph" },
  { label: "compute-02 GPU 温度偏高原因", key: "gpu-temp" },
  { label: "生成升级前预检结论", key: "pre-upgrade" },
];

function cloneBlocks(blocks: AgentBlock[]): AgentBlock[] {
  return blocks.map((b) => ({ ...b, actions: b.actions?.map((a) => ({ ...a, results: cloneBlocks(a.results) })) }));
}

/** Agent object profile + rail data (tool whitelist, recent calls). */
export function getAgentDemo(): { agent: AgentInfo; tools: AgentTool[]; calls: AgentCall[] } {
  return {
    agent: { ...AGENT_INFO },
    tools: AGENT_TOOLS.map((t) => ({ ...t })),
    calls: AGENT_CALLS.map((c) => ({ ...c })),
  };
}

/** Greeting blocks played when the agent object is (re)selected. */
export function agentGreeting(): AgentBlock[] {
  return cloneBlocks(AGENT_GREETING);
}

/** Canned scenario reply for a quick-chip/keyword match; generic fallback. */
export function agentScenario(key: string | null): AgentBlock[] {
  return cloneBlocks((key && AGENT_SCENARIOS[key]) || AGENT_GENERIC);
}

export function modelChips(): QuickChip[] {
  return MODEL_CHIPS.map((c) => ({ ...c }));
}

export function agentChips(): QuickChip[] {
  return AGENT_CHIPS.map((c) => ({ ...c }));
}
