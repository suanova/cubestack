// Shared types for the 智能助手 (Copilot) module.
//
// The shapes mirror the CubePilot contract (github.com/suanova/cubepilot
// web/src/api/types.ts + docs/cubepilot/api.md): the task tab is served by
// the ai.cubestack.io task CRDs, the agent tab by the AgentInstance /
// AgentTemplate / Skill CRDs plus the agent API (chat SSE + HITL), and the
// LLM catalog by the AI Gateway (same source as the chat tab).

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

/**
 * The provider name the platform owns: the AgentTemplate always carries an
 * entry with this name pointing at the AI Gateway, and the config save selects
 * a ref through it, so the agent sees one stable provider in front of the
 * gateway. Its prefix is internal plumbing users never chose (see
 * displayModelName). (Here rather than in agentcrd.ts because client
 * components use it and agentcrd pulls in the Kubernetes client.)
 */
export const PLATFORM_MODEL_NAME = "cubestack";

/** The model name users see for the agent's selection: the platform provider
 *  prefix ("cubestack/<id>") is internal plumbing users never chose, so only
 *  the model id after the "/" is shown; any other ref (an external provider's)
 *  is shown whole, as "<provider>/<modelId>". */
export function displayModelName(selectedModel: string): string {
  const prefix = `${PLATFORM_MODEL_NAME}/`;
  return selectedModel.startsWith(prefix) ? selectedModel.slice(prefix.length) : selectedModel;
}

/** One provider of the AgentTemplate (reference TemplateProviderSpec): an
 *  endpoint, an optional credential and the model ids it serves. The config
 *  page lists these; an instance selects a "<name>/<modelId>" ref among them. */
export interface TemplateProviderOption {
  /** The provider key — the ref prefix and the OpenClaw provider key. */
  name: string;
  endpoint?: string;
  /** The model ids this provider serves, in CR order. */
  models: string[];
  /** The provider binds a platform-managed credential Secret (a public
   *  provider has none). */
  keyed?: boolean;
  /** "system" = the platform's own provider (the builtin "cubestack" entry,
   *  pointing at the AI Gateway); "external" = declared on the AgentTemplate
   *  by the platform admin. */
  origin?: "system" | "external";
}

/** The caller's own assistant selections (reference /api/v1/agent/config:
 *  {exists, selectedModel, userInstructions}). Field names are the
 *  AgentInstance CRD's: exists = the instance is provisioned; selectedModel
 *  is the "<provider>/<modelId>" ref the agent runs ("" = unset; the UI shows
 *  the platform model); userInstructions "" = template instructions only. */
export interface AgentConfig {
  exists: boolean;
  selectedModel: string;
  userInstructions: string;
  /** The AgentTemplate's provider list (template-level, read-only here). */
  providers?: TemplateProviderOption[];
  /** The model ids the AI Gateway serves (the chat tab's source): what the
   *  platform provider's entry gets written with. */
  gatewayModels?: string[];
  /** true when the builtin AgentTemplate is missing from the operator
   *  namespace — the operator is not installed, or CUBESTACK_TASKS_NAMESPACE
   *  points somewhere else. The page then has no catalog and no runtime. */
  templateMissing?: boolean;
}

/** The caller's instance status (reference /api/v1/agent/status), projected
 *  from the AgentInstance CR (spec + status). */
export interface AgentStatus {
  exists: boolean;
  /** The instance CR name (e.g. <user>-cubepilot). */
  id?: string;
  /** Creating | Ready | Failed (empty = the operator has not observed it). */
  phase?: string;
  /** CR creation time (provisioning start), RFC3339. */
  startedAt?: string;
  uptimeSeconds?: number;
  user: string;
  lastActivity?: string;
  message?: string;
  /** The operator's ModelConfigured condition: false = the AgentTemplate
   *  offers no usable provider (no endpoint, no model ids, or a missing
   *  credential Secret), so every turn would fail. Undefined = not observed. */
  modelConfigured?: boolean;
  /** The operator's reason when modelConfigured is false. */
  modelMessage?: string;
  podName?: string;
  pvcName?: string;
}

/** One confirm allowlist rule (reference issue #116). */
export interface AllowlistRule {
  pattern: string;
  argPattern?: string;
  /** Human meaning, set for the hardcoded platform builtin read-only rules. */
  label?: string;
  /** true = the caller's own rule (stored on the AgentInstance CR, removable);
   *  false = a hardcoded platform default. */
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

// ── unified chat: agent (CubePilot) side — the real contract ─────────────
// The agent conversation is served by the CubePilot agent API (SSE,
// docs/cubepilot/api.md §4/§7); history is the runtime's document
// (user messages are plain strings, assistant/toolResult messages are block
// arrays).

/** One content block of a history message. */
export interface HistoryContentBlock {
  type: "text" | "toolCall";
  text?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
}

/** One history message (GET /api/v1/sessions/{key}/messages → items). */
export interface HistoryMessage {
  role: "user" | "assistant" | "toolResult";
  content: string | HistoryContentBlock[];
}

/** One SSE event of POST /api/v1/messages (data lines; type discriminates). */
export type AgentSseEvent =
  | { type: "message_start"; sessionId: string }
  | { type: "agent_thinking"; sessionId: string }
  | { type: "message_delta"; sessionId: string; delta: string }
  | { type: "text_replace"; sessionId: string; delta: string }
  | { type: "tool_call"; sessionId: string; name: string; callId?: string; arguments?: unknown }
  | { type: "tool_result"; sessionId: string; callId?: string; name?: string; output?: string }
  | { type: "message_done"; sessionId: string; error?: string; stopped?: boolean }
  | { type: "approval_pending"; sessionId: string; callId: string; name?: string; command?: string; level?: string; message?: string }
  | { type: "approval_resolved"; sessionId: string; callId: string; approved: boolean }
  | {
      type: "question_pending";
      sessionId: string;
      callId: string;
      question?: { questions?: AgentQuestionItem[]; timeoutSeconds?: number };
    }
  | { type: "question_resolved"; sessionId: string; callId: string; message?: string };

/** One question of an ask_user prompt (question.questions[]). */
export interface AgentQuestionItem {
  questionId: string;
  header?: string;
  question: string;
  options?: AgentQuestionOption[];
  multiSelect?: boolean;
}

export interface AgentQuestionOption {
  label: string;
  description?: string;
}
