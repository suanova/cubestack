// In-memory demo state for the 智能助手 (Copilot) module.
//
// The portal has no agent/LLM backend yet: the /api/cubepilot/* route handlers
// read and mutate the singleton below, seeded with realistic demo data. All
// state is per-process and resets on restart — deliberately, this is a demo
// layer, not storage. A real backend replaces these modules without touching
// the pages (same wire shapes, see lib/cubepilot/types.ts).

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
  QuickChip,
  SessionInfo,
  SkillInfo,
} from "./types";

interface Session {
  key: string;
  title?: string;
  messages: ChatMessage[];
}

interface State {
  sessions: Map<string, Session>;
  /** Session order (newest first). */
  sessionOrder: string[];
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

// ── seeding ──────────────────────────────────────────────────────────────

/** Seed the demo state. */
export function seedState(): State {

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

  const seq = 0;

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

/** Test hook: re-seed the singleton. */
export function __resetStore(): void {
  state = seedState();
}

function nextId(prefix: string): string {
  return `${prefix}-${(++state.seq).toString(36)}`;
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
  // Demo: the agent has been up for 2d 5h.
  const uptimeSeconds = 2 * 24 * 3600 + 5 * 3600;
  const startedAt = new Date(Date.now() - uptimeSeconds * 1000).toISOString();
  return {
    exists: state.config.exists,
    id: `agent-${user}`,
    phase: "Ready",
    startedAt,
    uptimeSeconds,
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
