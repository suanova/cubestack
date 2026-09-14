// Task CRD facade — the read/write layer over the ai.cubestack.io task CRDs
// (tasks / taskruns / tasktemplates) defined by the CubePilot operator
// (see suanova/cubepilot internal/api/v1alpha1 + internal/server/handlers_tasks.go).
// The portal's /api/cubepilot/tasks* routes project these CRs into the
// Task / TaskTemplate / Report shapes the 任务 tab consumes, keeping the
// reference API's vocabulary (owner scoping via spec.owner, the
// cubepilot/display-name annotation, manual-run via annotation, TaskRuns
// labelled cubepilot/task=<task name>).
//
// All CRs live in one namespace (the operator's); it is provided by
// CUBESTACK_TASKS_NAMESPACE. There is no default: unset = the routes answer
// 503 with a clear message.

import { randomBytes } from "node:crypto";

import { getCustomObjectsClient } from "@/lib/kubernetes";
import type { Report, Task, TaskParam, TaskTemplate } from "./types";

const GROUP = "ai.cubestack.io";
const VERSION = "v1alpha1";

/** Human-facing name (the CR name is DNS-1123 sanitized and lossy for CJK). */
export const DISPLAY_NAME_ANNOTATION = "cubepilot/display-name";
/** Set on manual runs; the operator's scheduler fires the task once. */
export const MANUAL_RUN_ANNOTATION = "cubepilot/manual-run";
/** TaskRun CRs carry the owning task's name. */
export const TASK_RUN_LABEL = "cubepilot/task";

// ── raw CR shapes (only the fields we read / write) ──────────────────────

export interface TaskCr {
  metadata?: {
    name?: string;
    creationTimestamp?: string;
    annotations?: Record<string, string>;
  };
  spec?: {
    templateRef?: string;
    instruction?: string;
    params?: Record<string, string>;
    owner?: string;
    trigger?: string;
    cron?: string;
    state?: string;
  };
  status?: {
    phase?: string;
    lastRunTime?: string;
    lastStatus?: string;
    nextRunTime?: string;
    lastTaskRunName?: string;
  };
}

export interface TaskRunCr {
  metadata?: {
    name?: string;
    creationTimestamp?: string;
  };
  spec?: {
    creatorTaskRef?: { name?: string };
    taskName?: string;
    owner?: string;
    trigger?: string;
  };
  status?: {
    phase?: string;
    summary?: { total?: number; abnormal?: number; p0?: number; p1?: number; p2?: number };
    content?: string;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
  };
}

export interface TaskTemplateCr {
  metadata?: {
    name?: string;
    creationTimestamp?: string;
  };
  spec?: {
    displayName?: string;
    description?: string;
    instruction?: string;
    paramsSchema?: TaskParam[];
    defaultCron?: string;
    skills?: string[];
  };
}

// ── namespace ─────────────────────────────────────────────────────────────

/** The task-CR namespace, or null when CUBESTACK_TASKS_NAMESPACE is unset. */
export function tasksNamespace(): string | null {
  const ns = (process.env.CUBESTACK_TASKS_NAMESPACE ?? "").trim();
  return ns || null;
}

/** Response for the unset-namespace case (all task routes). */
export function namespaceMissingResponse(): Response {
  return Response.json(
    { error: "CUBESTACK_TASKS_NAMESPACE is not set (namespace of the ai.cubestack.io task CRDs)" },
    { status: 503 },
  );
}

/** Response for k8s API failures (404 → CRDs probably not installed). */
export function k8sErrorResponse(e: unknown): Response {
  const statusCode = (e as { statusCode?: number })?.statusCode;
  const message = e instanceof Error ? e.message : String(e);
  return Response.json({ error: `cluster error: ${message}` }, { status: statusCode === 404 ? 503 : 502 });
}

// ── DTO projection (CR → the tab's shapes) ───────────────────────────────

export function taskFromCr(cr: TaskCr): Task {
  const lastStatus = cr.status?.lastStatus;
  return {
    id: cr.metadata?.name ?? "",
    // The display-name annotation wins; the CR name is a DNS-1123 fallback.
    name: cr.metadata?.annotations?.[DISPLAY_NAME_ANNOTATION] || cr.metadata?.name || "",
    prompt: cr.spec?.instruction ?? "",
    schedule: cr.spec?.cron ?? "",
    templateRef: cr.spec?.templateRef || undefined,
    // Empty state reads as Enabled (pre-CRD CRs), mirroring Task.Enabled().
    enabled: (cr.spec?.state ?? "Enabled") !== "Paused",
    creator: cr.spec?.owner ?? "",
    createdAt: cr.metadata?.creationTimestamp ?? "",
    lastRunAt: cr.status?.lastRunTime,
    lastStatus: lastStatus === "success" || lastStatus === "failed" ? lastStatus : undefined,
    nextRunAt: cr.status?.nextRunTime,
  };
}

export function reportFromCr(cr: TaskRunCr, fallbackTaskName: string): Report {
  const phase = cr.status?.phase ?? "";
  // Pending / Running must not be presented as a finished success.
  const status = phase === "Completed" ? "success" : phase === "Failed" || phase === "Cancelled" ? "failed" : "running";
  const s = cr.status?.summary;
  return {
    id: cr.metadata?.name ?? "",
    taskId: cr.spec?.creatorTaskRef?.name ?? "",
    taskName: cr.spec?.taskName || fallbackTaskName,
    trigger: cr.spec?.trigger === "Cron" ? "Cron" : "Manual",
    status,
    startedAt: cr.status?.startedAt ?? cr.metadata?.creationTimestamp ?? "",
    finishedAt: cr.status?.finishedAt ?? "",
    content: cr.status?.content ?? "",
    p0: s?.p0 ?? 0,
    p1: s?.p1 ?? 0,
    p2: s?.p2 ?? 0,
  };
}

export function templateFromCr(cr: TaskTemplateCr): TaskTemplate {
  return {
    name: cr.metadata?.name ?? "",
    displayName: cr.spec?.displayName || cr.metadata?.name || "",
    description: cr.spec?.description ?? "",
    instruction: cr.spec?.instruction ?? "",
    paramsSchema: cr.spec?.paramsSchema ?? [],
    defaultCron: cr.spec?.defaultCron ?? "",
    skills: cr.spec?.skills ?? [],
  };
}

// ── k8s operations ────────────────────────────────────────────────────────

async function listCr<T>(plural: string, labelSelector?: string): Promise<T[]> {
  const co = getCustomObjectsClient();
  const res = await co.listNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace: tasksNamespace() as string,
    plural,
    ...(labelSelector ? { labelSelector } : {}),
  });
  return (res.items ?? []) as T[];
}

async function getCr<T>(plural: string, name: string): Promise<T | null> {
  try {
    const co = getCustomObjectsClient();
    return (await co.getNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: tasksNamespace() as string,
      plural,
      name,
    })) as T;
  } catch (e) {
    if ((e as { statusCode?: number })?.statusCode === 404) return null;
    throw e;
  }
}

export function listTaskCrs(): Promise<TaskCr[]> {
  return listCr<TaskCr>("tasks");
}

/** The TaskRuns of one task (labelled cubepilot/task=<name>). */
export function listTaskRunCrs(taskName: string): Promise<TaskRunCr[]> {
  return listCr<TaskRunCr>("taskruns", `${TASK_RUN_LABEL}=${taskName}`);
}

export function listTemplateCrs(): Promise<TaskTemplateCr[]> {
  return listCr<TaskTemplateCr>("tasktemplates");
}

export function getTaskCr(name: string): Promise<TaskCr | null> {
  return getCr<TaskCr>("tasks", name);
}

export function getTemplateCr(name: string): Promise<TaskTemplateCr | null> {
  return getCr<TaskTemplateCr>("tasktemplates", name);
}

/** DNS-1123 task CR name: <owner>-task-<8 hex> (the reference API's form). */
export function taskCrName(owner: string): string {
  const base =
    owner
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "user";
  return `${base}-task-${randomBytes(4).toString("hex")}`;
}

export interface CreateTaskCrInput {
  /** Human-facing name (stored on the display-name annotation). */
  name: string;
  /** Rendered instruction snapshot (what the agent will see). */
  instruction: string;
  cron: string;
  templateRef?: string;
  params?: Record<string, string>;
  /** Execution identity; becomes spec.owner. */
  owner: string;
}

export async function createTaskCr(input: CreateTaskCrInput): Promise<TaskCr> {
  const co = getCustomObjectsClient();
  const ns = tasksNamespace() as string;
  const body = {
    apiVersion: `${GROUP}/${VERSION}`,
    kind: "Task",
    metadata: {
      name: taskCrName(input.owner),
      namespace: ns,
      annotations: { [DISPLAY_NAME_ANNOTATION]: input.name },
    },
    spec: {
      ...(input.templateRef ? { templateRef: input.templateRef } : {}),
      instruction: input.instruction,
      ...(input.params && Object.keys(input.params).length > 0 ? { params: input.params } : {}),
      owner: input.owner,
      trigger: input.cron ? "Cron" : "Manual",
      ...(input.cron ? { cron: input.cron } : {}),
      state: "Enabled",
    },
  };
  return (await co.createNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace: ns,
    plural: "tasks",
    body,
  })) as TaskCr;
}

export async function patchTaskCrState(name: string, state: "Enabled" | "Paused"): Promise<TaskCr> {
  const co = getCustomObjectsClient();
  // client-node sends custom-object patches as JSON Patch
  // (application/json-patch+json); an "add" op replaces an existing member.
  const body = [{ op: "add", path: "/spec/state", value: state }];
  return (await co.patchNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace: tasksNamespace() as string,
    plural: "tasks",
    name,
    body,
    fieldManager: "cubestack-web",
  })) as TaskCr;
}

/**
 * Ask the operator's scheduler to fire the task once (manual run). The
 * annotations map is merged from the fetched CR so the op is valid whether or
 * not the CR has other annotations yet.
 */
export async function markManualRun(task: TaskCr): Promise<void> {
  const co = getCustomObjectsClient();
  const annotations = {
    ...(task.metadata?.annotations ?? {}),
    [MANUAL_RUN_ANNOTATION]: new Date().toISOString(),
  };
  const body = [{ op: "add", path: "/metadata/annotations", value: annotations }];
  await co.patchNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace: tasksNamespace() as string,
    plural: "tasks",
    name: task.metadata?.name as string,
    body,
    fieldManager: "cubestack-web",
  });
}

export async function deleteTaskCr(name: string): Promise<void> {
  const co = getCustomObjectsClient();
  await co.deleteNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace: tasksNamespace() as string,
    plural: "tasks",
    name,
  });
}

// ── instruction / param resolution (mirrors the reference API) ───────────

/** Interpolate {{param}} placeholders. */
export function renderInstruction(instruction: string, params: Record<string, string>): string {
  let out = instruction;
  for (const [k, v] of Object.entries(params)) {
    out = out.split("{{" + k + "}}").join(v);
  }
  return out;
}

/**
 * Template param defaults merged with overrides; enum values are validated.
 * Extra override keys (not in the schema) are kept.
 */
export function resolveParams(schema: TaskParam[], overrides?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const p of schema) {
    merged[p.name] = p.default ?? "";
    if (overrides && overrides[p.name] !== undefined) merged[p.name] = overrides[p.name];
    if (p.enum && p.enum.length > 0 && !p.enum.includes(merged[p.name])) {
      throw new Error(`invalid value for param ${p.name}: ${merged[p.name]}`);
    }
  }
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (!(k in merged)) merged[k] = v;
  }
  return merged;
}
