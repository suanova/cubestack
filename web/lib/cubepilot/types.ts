// Shared types for the 智能助手 (Copilot) module.
//
// The portal has no agent/LLM backend yet, so this module is served by
// in-memory demo state (lib/cubepilot/store.ts) behind /api/cubepilot/* routes.
// The shapes mirror the CubePilot REST contract (github.com/suanova/cubepilot
// web/src/api/types.ts) so a real backend can replace the demo store later
// without touching the pages.

/** One chat session (a conversation with the assistant). */
export interface SessionInfo {
  sessionKey: string;
  title?: string;
}

/** A tool invocation rendered as a card inside an assistant bubble. */
export interface ChatToolCall {
  name: string;
  /** Command / argument summary shown in the card body. */
  cmd: string;
  /** The tool's output, shown under the command when present. */
  result?: string;
}

/** One history message. Assistant messages may carry tool calls. */
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  tools?: ChatToolCall[];
}

/** A scheduled or manual AI task (FR-M4 analogue of the reference TasksView). */
export interface Task {
  id: string;
  name: string;
  /** Free-form instruction; empty when bound to a template. */
  prompt: string;
  /** Cron expression (5 fields, UTC); empty = manual only. */
  schedule: string;
  /** Bound TaskTemplate name; absent/"" = free-form. */
  templateRef?: string;
  enabled: boolean;
  creator: string;
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: "success" | "failed" | "running";
  nextRunAt?: string;
}

export interface TaskParam {
  name: string;
  type?: string;
  default?: string;
  enum?: string[];
}

/** A reusable task definition; tasks bind one by name (reference TaskTemplate). */
export interface TaskTemplate {
  name: string;
  displayName: string;
  description?: string;
  /** Instruction with {{param}} placeholders, rendered on save. */
  instruction: string;
  paramsSchema: TaskParam[];
  defaultCron?: string;
  skills?: string[];
}

/** One task run and its report (the agent's real output in the reference). */
export interface Report {
  id: string;
  taskId: string;
  taskName: string;
  trigger: "Cron" | "Manual";
  /** 'running' until the (simulated) run finishes, then success/failed. */
  status: "success" | "failed" | "running";
  startedAt: string;
  /** Set once finished; empty while running. */
  finishedAt: string;
  content: string;
  p0: number;
  p1: number;
  p2: number;
}

/** An OpenAI-compatible model in the platform catalog (reference LLM config). */
export interface LlmModel {
  name: string;
  /** API root, e.g. https://llm.cubestack.local/v1 (no /chat/completions). */
  endpoint: string;
  /** true when the model is backed by a stored credential, false when public. */
  keyed: boolean;
}

/** The caller's own assistant selections (reference /api/agent/config). */
export interface AgentConfig {
  /** false = the caller has no provisioned instance. */
  exists: boolean;
  /** Selected model name; "" = runtime default. */
  model: string;
  /** Custom system prompt; "" = built-in persona only. */
  systemPrompt: string;
}

/** The caller's instance runtime status (reference /api/agent/status). */
export interface AgentStatus {
  exists: boolean;
  id?: string;
  phase?: string;
  startedAt?: string;
  uptimeSeconds?: number;
  gatewayImage?: string;
  user: string;
}

/** One confirm allowlist rule (reference issue #116). */
export interface AllowlistRule {
  pattern: string;
  argPattern?: string;
  /** Human meaning, set for platform builtin read-only rules. */
  label?: string;
  /** true when the rule comes from the instance's own state, not the template. */
  owned: boolean;
}

/** Effective + owned confirmation posture (reference /api/agent/confirm). */
export interface ConfirmView {
  exists: boolean;
  confirmPolicy: string;
  templatePolicy: string;
  /** "" = following the template default. */
  override: string;
  allowlist: AllowlistRule[];
  /** "up" | "pairing" | "down" | "unconfigured". */
  channel: string;
}

/** A platform skill that can be enabled per instance (reference skills). */
export interface SkillInfo {
  name: string;
  displayName: string;
  description: string;
  enabled: boolean;
}

/** A model served by the AI Gateway (one entry of its GET /v1/models). */
export interface GatewayModel {
  /** Model id — sent as `model` in chat completions. */
  id: string;
  /** Gateway-reported owner (may be empty). */
  ownedBy: string;
}

// ── unified chat: agent (CubePilot) side ─────────────────────────────────

/** One canned demo block of an agent reply, played back sequentially. */
export interface AgentBlock {
  /** Paragraph text. */
  p?: string;
  /** Command block (mono, dark). */
  cmd?: string;
  /** Tool output block (mono, boxed). */
  out?: string;
  /** Action buttons offered to the user. */
  actions?: AgentAction[];
  /** Meta line under the reply (tools used, references…). */
  meta?: string;
}

/** A clickable action inside an agent reply (demo: appends canned results). */
export interface AgentAction {
  label: string;
  /** Label swapped in after the action is used. */
  doneLabel: string;
  primary?: boolean;
  /** Blocks appended to the message when the action is clicked. */
  results: AgentBlock[];
}

/** Demo profile of the CubePilot agent shown in the object list and rail. */
export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  /** Seconds since the last heartbeat (demo). */
  heartbeat: number;
  /** Number of read-only tools. */
  ro: number;
  /** Number of write tools (approval required). */
  rw: number;
}

/** One tool-whitelist row in the agent rail. */
export interface AgentTool {
  name: string;
  scope: "ro" | "rw";
}

/** One recent-tool-call row in the agent rail. */
export interface AgentCall {
  time: string;
  tool: string;
  scope: "ro" | "rw";
}

/** A quick-question chip above the thread; agent chips carry a scenario key. */
export interface QuickChip {
  label: string;
  key?: string;
}
