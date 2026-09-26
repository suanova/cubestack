import { getCoreClient, getCustomObjectsClient } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";
import { devImageFor } from "@/lib/devenvironments/images";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler talks to the live cluster, so it must not be prerendered at
// build time.
export const dynamic = "force-dynamic";

// Operator CRD group/version (operator/api/v1alpha1/groupversion_info.go) and
// the plural registered in operator/config/crd/bases/*.yaml.
const GROUP = "ai.cubestack.io";
const VERSION = "v1alpha1";
const PLURAL_DEVENV = "devenvironments";

/**
 * Shape of a single environment rendered by the /dev-environments page. This is
 * the read/display contract; everything is projected from the live cluster's
 * DevEnvironment CRs.
 */
export interface DevEnvironmentSummary {
  // identity
  name: string;
  namespace: string;
  createdAt: string | null;
  // desired spec
  type: "jupyter" | "ssh" | "vscode";
  image: string;
  running: boolean;
  resources: {
    // Null when the environment requests no accelerator — spec.resources.gpu
    // is absent. The CRD deliberately has no "count: 0": omitting the block is
    // the only way to ask for no GPU, and it is also what exempts an image
    // from the brand gate.
    gpu: { vendor: "nvidia" | "metax"; count: number } | null;
    cpu: string;
    memory: string;
  };
  storage: { size: string; mountPath: string | null } | null;
  // spec.volumes: extra PVCs mounted alongside the workspace.
  volumes: Array<{ name: string; pvcName: string; mountPath: string; readOnly: boolean }>;
  // Variable *names* only — a value can be a registry token (HF_TOKEN), and the
  // names alone answer what the environment was configured with.
  envNames: string[];
  args: string[];
  ports: Array<{ name: string; type: "http" | "tcp" | "udp"; containerPort: number }>;
  idleTimeout: number;
  sshEnabled: boolean;
  // observed state (phase is null until the controller reports it)
  phase: string | null;
  phaseReason: string | null;
  endpoints: Array<{ name: string; address: string }>;
  conditions: Array<{ type: string; status: string; reason: string; message: string }>;
  // The client keypair the controller minted for ssh login, so its owner can
  // retrieve the private half. Absent when spec.ssh.authorizedKeysSecret names
  // the user's own Secret — that holds public keys, not a client key.
  sshClientKeySecret: string | null;
}

interface Condition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
}
interface Endpoint {
  name?: string;
  address?: string;
}
interface DevEnvResources {
  gpu?: { vendor?: string; count?: number };
  cpu?: string;
  memory?: string;
}
interface DevEnvSpec {
  type?: string;
  image?: string;
  running?: boolean;
  resources?: DevEnvResources;
  storage?: { size?: string; mountPath?: string };
  volumes?: Array<{ name?: string; pvcName?: string; mountPath?: string; readOnly?: boolean }>;
  ports?: Array<{ name?: string; type?: string; containerPort?: number }>;
  runtime?: { env?: Array<{ name?: string }>; args?: string[] };
  lifecycle?: { idleTimeout?: number };
  ssh?: { enabled?: boolean };
}
interface DevEnvStatus {
  phase?: { name?: string; reason?: string };
  endpoints?: Endpoint[];
  conditions?: Condition[];
  sshClientKeySecret?: { name?: string };
}
interface DevEnv {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string };
  spec?: DevEnvSpec;
  status?: DevEnvStatus;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Project one DevEnvironment CR into a page-ready record. */
function project(env: DevEnv): DevEnvironmentSummary {
  const spec = env.spec ?? {};
  const status = env.status ?? {};
  const gpu = spec.resources?.gpu;
  return {
    name: env.metadata?.name ?? "?",
    namespace: env.metadata?.namespace ?? "",
    createdAt: env.metadata?.creationTimestamp ?? null,
    type: (spec.type === "jupyter" || spec.type === "ssh" || spec.type === "vscode" ? spec.type : "ssh"),
    image: spec.image ?? "—",
    running: spec.running ?? false,
    resources: {
      // The vendor defaults to nvidia and the count to 1 exactly as the CRD
      // does; an absent gpu block stays absent rather than becoming a GPU.
      gpu: gpu
        ? { vendor: gpu.vendor === "metax" ? "metax" : "nvidia", count: num(gpu.count) || 1 }
        : null,
      cpu: spec.resources?.cpu ?? "—",
      memory: spec.resources?.memory ?? "—",
    },
    storage: spec.storage
      // A null mountPath is "not stated": the controller derives the path — and
      // the container's HOME — from the runtime identity, so the panel must not
      // invent "/workspace". A jupyter environment's workspace is /home/jovyan.
      ? { size: spec.storage.size ?? "10Gi", mountPath: spec.storage.mountPath?.trim() || null }
      : null,
    volumes: (spec.volumes ?? []).map((v) => ({
      name: v.name ?? "",
      pvcName: v.pvcName ?? "",
      mountPath: v.mountPath ?? "",
      readOnly: v.readOnly ?? false,
    })),
    envNames: (spec.runtime?.env ?? []).map((e) => e.name ?? "").filter(Boolean),
    args: spec.runtime?.args ?? [],
    ports: (spec.ports ?? []).map((p) => ({
      name: p.name ?? "",
      // The CRD's own default for an absent type.
      type: p.type === "tcp" || p.type === "udp" ? p.type : "http",
      containerPort: num(p.containerPort),
    })),
    idleTimeout: num(spec.lifecycle?.idleTimeout),
    sshEnabled: spec.ssh?.enabled ?? false,
    phase: status.phase?.name ?? null,
    phaseReason: status.phase?.reason ?? null,
    endpoints: (status.endpoints ?? []).map((e) => ({
      name: e.name ?? "",
      address: e.address ?? "",
    })),
    conditions: (status.conditions ?? []).map((c) => ({
      type: c.type ?? "?",
      status: c.status ?? "Unknown",
      reason: c.reason ?? "",
      message: c.message ?? "",
    })),
    sshClientKeySecret: status.sshClientKeySecret?.name ?? null,
  };
}

/**
 * GET /api/devenvironments
 *
 * Lists every DevEnvironment in the cluster (any namespace).
 */
export const GET = withAuth(async () => {
  try {
    const co = getCustomObjectsClient();
    const res = await co.listClusterCustomObject({
      group: GROUP,
      version: VERSION,
      plural: PLURAL_DEVENV,
    });
    const items = ((res.items ?? []) as DevEnv[]).map(project);
    // Newest first, mirroring the inference-services list ordering.
    items.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    return Response.json({ items });
  } catch (err) {
    console.error("Failed to list dev environments:", err);
    return Response.json({ error: "Failed to load dev environments" }, { status: 500 });
  }
});

// ── create (POST) ────────────────────────────────────────────────────────────

const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
// spec.runtime.user's own validation, mirrored from the CRD
// (operator/api/v1alpha1/devenvironment_types.go: it is MaxLength=32 with
// Pattern ^[a-z_][a-z0-9_-]*$, enforced by the API server and nothing else).
const RUNTIME_USER_RE = /^[a-z_][a-z0-9_-]*$/;
const RUNTIME_USER_MAX = 32;
// Neither runAsUser nor runAsGroup is bounded in the CRD; nothing wider than an
// int32 is a uid or gid, and a value past it would be rejected by the API
// server as an opaque 422 rather than here.
const RUN_AS_ID_MAX = 2147483647;
const DEVENV_TYPES = ["jupyter", "ssh", "vscode"] as const;
// The accelerator is a single choice, "none" included, mirroring
// spec.resources.gpu.vendor plus the absence of the block.
const ACCELERATORS = ["none", "nvidia", "metax"] as const;
// corev1.EnvVar.name's own validation, enforced by the API server and nothing
// else — an invalid name would surface as an opaque 422 on the CR, not here.
const ENV_NAME_RE = /^[-._a-zA-Z][-._a-zA-Z0-9]*$/;
const PORT_TYPES = ["http", "tcp", "udp"] as const;

/**
 * Split a command line into argv: whitespace separates, and single or double
 * quotes group, so an argument carrying a space ("--name \"a b\"") survives as
 * one. Returns null on an unbalanced quote — starting the container with
 * arguments the user never wrote is worse than refusing the request.
 */
function splitArgs(input: string): string[] | null {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) return null;
  if (started) argv.push(current);
  return argv;
}

/**
 * spec.volumes[].name: an identifier derived from the PVC it mounts. The CRD
 * only asks for MinLength=1, but the controller renders it as a pod volume name
 * — a DNS-1123 label of at most 63 characters — so the slug is capped short
 * enough to leave room for a de-duplication suffix.
 */
function volumeNameBase(pvcName: string): string {
  const slug = pvcName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 57);
  return slug || "volume";
}

interface CreateBody {
  namespace?: string;
  name?: string;
  type?: string;
  image?: string;
  accelerator?: string;
  gpuCount?: number;
  cpu?: string;
  memory?: string;
  storageGi?: number;
  idleTimeout?: number;
  // The runtime identity (spec.runtime). All optional: a client that states
  // none gets the image catalog's identity, as before. Named after the CR's own
  // leaves, with the parent prefix the rest of this body already uses
  // (storageGi ← storage.size, gpuCount ← resources.gpu.count).
  runtimeUser?: string; // → spec.runtime.user
  runAsUser?: number; // → spec.runtime.securityContext.runAsUser
  runAsGroup?: number; // → spec.runtime.securityContext.runAsGroup
  // Form-shaped where the UI is a single box, CR-named where the UI already
  // edits a CR leaf.
  mountPath?: string; // → spec.storage.mountPath (absent = derived)
  volumes?: Array<{ pvcName?: string; mountPath?: string }>; // → spec.volumes[] (name is derived here)
  env?: Array<{ name?: string; value?: string }>; // → spec.runtime.env[]
  args?: string; // → spec.runtime.args (one command line, split here)
  ports?: Array<{ name?: string; containerPort?: number; type?: string }>; // → spec.ports[]
}

/**
 * POST /api/devenvironments
 *
 * Creates a DevEnvironment. Structural validation here (name/type/image/
 * resources), then the CR is written; the operator's controller and admission
 * webhooks re-validate on reconcile. Requires RBAC to create the CR in the
 * target namespace.
 */
export const POST = withAuth(async (req) => {
  try {
    const body = (await req.json()) as CreateBody;
    const ValidationError = (error: string) => Response.json({ error }, { status: 400 });

    if (!body.name || !DNS_LABEL_RE.test(body.name)) {
      return ValidationError("环境名称不合法:需小写字母/数字/中划线,DNS-1123 label。");
    }
    if (!body.namespace || !body.image?.trim()) {
      return ValidationError("namespace、image 均为必填。");
    }
    // Trimmed once and used for both the catalog lookup and the CR: a padded
    // reference is a different image to the registry, and looking the two up
    // separately is how a catalog image stops being recognized as one.
    const image = body.image.trim();
    if (!body.type || !(DEVENV_TYPES as readonly string[]).includes(body.type)) {
      return ValidationError(`type 必须为 ${DEVENV_TYPES.join(" / ")} 之一。`);
    }
    // "none" omits spec.resources.gpu entirely: the CRD has no zero count, and
    // the absence of the block is what keeps the image out of the brand gate.
    const accelerator = body.accelerator ?? "none";
    if (!(ACCELERATORS as readonly string[]).includes(accelerator)) {
      return ValidationError(`accelerator 必须为 ${ACCELERATORS.join(" / ")} 之一。`);
    }
    const gpuEnabled = accelerator !== "none";
    const gpuCount = body.gpuCount ?? 1;
    if (gpuEnabled && (!Number.isInteger(gpuCount) || gpuCount < 1 || gpuCount > 16)) {
      return ValidationError("gpuCount 需为 1–16 之间的整数。");
    }
    if (body.storageGi !== undefined && (body.storageGi < 20 || body.storageGi > 800)) {
      return ValidationError("storageGi 需在 20–800 之间。");
    }
    const idleTimeout = body.idleTimeout === undefined ? 0 : body.idleTimeout;
    if (!Number.isInteger(idleTimeout) || idleTimeout < 0) {
      return ValidationError("idleTimeout 需为非负整数(秒)。");
    }

    // The runtime identity. An empty account is "not stated", not an account:
    // spec.runtime.user is omitempty and does not match the CRD's own pattern,
    // so writing "" would be an API-server 422 the user cannot act on.
    if (body.runtimeUser) {
      if (body.runtimeUser.length > RUNTIME_USER_MAX || !RUNTIME_USER_RE.test(body.runtimeUser)) {
        return ValidationError("运行账号不合法:需以字母或下划线开头,仅含小写字母/数字/下划线/中划线,最长 32 字符。");
      }
      // Root is the one account whose uid the platform knows: the controller
      // serves and advertises "root" only at runAsUser 0, so asking for it at
      // any other uid describes an sshd that cannot serve the account it names.
      // Every other account/uid pairing is the image's to get right and is
      // unverifiable here (docs/design/devenv-images/decision.md).
      if (body.runtimeUser === "root" && body.runAsUser !== 0) {
        return ValidationError("运行账号 root 需与以 root 身份运行(runAsUser 为 0)同时使用。");
      }
    }
    // Never through `||` or a truthiness test: runAsUser 0 is the root request,
    // and `body.runAsUser || 1000` would silently turn a root environment into
    // an ordinary uid 1000 one.
    for (const [field, value] of [
      ["runAsUser", body.runAsUser],
      ["runAsGroup", body.runAsGroup],
    ] as const) {
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 0 || value > RUN_AS_ID_MAX) {
        return ValidationError(`${field} 需为 0–${RUN_AS_ID_MAX} 之间的整数。`);
      }
    }

    // The workspace path. Left empty it is not stated at all: the controller then
    // derives the path — and the container's HOME — from the runtime identity,
    // and pinning it from here would move a jupyter environment's home off
    // /home/jovyan onto whatever this route guessed.
    const workspacePath = body.mountPath?.trim() ?? "";
    if (workspacePath && (!workspacePath.startsWith("/") || workspacePath === "/")) {
      return ValidationError("workspace 挂载路径需为以 / 开头的绝对路径,且不能为 /。");
    }
    // spec.storage.mountPath exists only inside spec.storage: a path with no
    // claim behind it describes a mount nothing can honour, and the API server
    // would prune it rather than complain.
    if (workspacePath && body.storageGi === undefined) {
      return ValidationError("workspace 挂载路径需与持久化存储(storageGi)同时提交。");
    }

    const volumes: Array<{ name: string; pvcName: string; mountPath: string }> = [];
    const volumeNames = new Set<string>();
    // One path may be claimed once: two mounts at one path is a pod the API
    // server rejects. The workspace path is part of that set.
    const mountedPaths = new Set<string>(workspacePath ? [workspacePath] : []);
    for (const v of Array.isArray(body.volumes) ? body.volumes : []) {
      const pvcName = v.pvcName?.trim() ?? "";
      const mountPath = v.mountPath?.trim() ?? "";
      // A row the user added and never filled is not a request.
      if (!pvcName && !mountPath) continue;
      if (!pvcName || !mountPath) {
        return ValidationError("额外 PVC 需同时填写 PVC 名称与挂载路径。");
      }
      if (!mountPath.startsWith("/") || mountPath === "/") {
        return ValidationError(`PVC 挂载路径 '${mountPath}' 需为以 / 开头的绝对路径,且不能为 /。`);
      }
      if (mountedPaths.has(mountPath)) {
        return ValidationError(`挂载路径 '${mountPath}' 重复。`);
      }
      mountedPaths.add(mountPath);
      // The identifier is derived rather than asked for, so mounting one PVC
      // twice is two entries with distinct names instead of an error.
      const base = volumeNameBase(pvcName);
      let name = base;
      for (let n = 2; volumeNames.has(name); n++) name = `${base}-${n}`;
      volumeNames.add(name);
      volumes.push({ name, pvcName, mountPath });
    }

    const env: Array<{ name: string; value: string }> = [];
    const envNames = new Set<string>();
    for (const e of Array.isArray(body.env) ? body.env : []) {
      const name = e.name?.trim() ?? "";
      const value = e.value ?? "";
      if (!name && !value) continue;
      if (!name) return ValidationError("环境变量需填写变量名。");
      if (!ENV_NAME_RE.test(name)) {
        return ValidationError(`环境变量名 '${name}' 不合法:需以字母/下划线/点/中划线开头,仅含字母/数字/下划线/点/中划线。`);
      }
      if (envNames.has(name)) return ValidationError(`环境变量 '${name}' 重复。`);
      envNames.add(name);
      // HOME is not just another variable: an absolute one decides where the
      // workspace mounts (StorageSpec.MountPath), so a relative value would tell
      // the container its home is at a path that does not exist.
      if (name === "HOME" && !value.startsWith("/")) {
        return ValidationError("环境变量 HOME 需为绝对路径(以 / 开头),它同时决定工作区挂载路径。");
      }
      env.push({ name, value });
    }

    const argsLine = body.args?.trim() ?? "";
    const args = argsLine ? splitArgs(argsLine) : [];
    if (args === null) return ValidationError("启动参数引号不匹配。");

    const ports: Array<{ name: string; type: string; containerPort: number }> = [];
    const portNames = new Set<string>();
    // tcp and udp are published over one L4 pool, where a number is held by a
    // single protocol; http goes through the Gateway and may share a number.
    const l4Ports = new Set<number>();
    for (const p of Array.isArray(body.ports) ? body.ports : []) {
      const name = p.name?.trim() ?? "";
      const type = p.type?.trim() || "http";
      const containerPort = p.containerPort;
      // "Untouched" is decided by the name and the number alone: the type always
      // has a value, so counting it would make every added row look filled.
      if (!name && containerPort === undefined) continue;
      if (!name) return ValidationError("额外端口需填写名称。");
      // The name is published in the sub path and in status.endpoints, so the
      // CRD requires it unique — stated in prose, not in the schema.
      if (portNames.has(name)) return ValidationError(`端口名称 '${name}' 重复,名称用于发布子路径,须唯一。`);
      if (!(PORT_TYPES as readonly string[]).includes(type)) {
        return ValidationError(`端口类型须为 ${PORT_TYPES.join(" / ")} 之一。`);
      }
      if (containerPort === undefined || !Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
        return ValidationError("端口(containerPort)需为 1–65535 之间的整数。");
      }
      if (type !== "http") {
        if (l4Ports.has(containerPort)) {
          return ValidationError(`端口 ${containerPort} 已被另一条 tcp/udp 规则占用,tcp 与 udp 共用同一端口池。`);
        }
        l4Ports.add(containerPort);
      }
      portNames.add(name);
      ports.push({ name, type, containerPort });
    }

    const core = getCoreClient();
    const co = getCustomObjectsClient();

    // Namespace must exist.
    const envelope = await core.listNamespace();
    const nsNames = new Set((envelope.items ?? []).map((ns) => ns.metadata?.name));
    if (!nsNames.has(body.namespace)) {
      return ValidationError(`namespace '${body.namespace}' 不存在。`);
    }

    // The environment name must be unique in its namespace (the CR name is the
    // object identity).
    const existing = await co.listClusterCustomObject({
      group: GROUP,
      version: VERSION,
      plural: PLURAL_DEVENV,
    });
    const exists = (existing.items ?? []).some(
      (e: DevEnv) => e.metadata?.namespace === body.namespace && e.metadata?.name === body.name,
    );
    if (exists) return ValidationError(`环境 '${body.name}' 已存在。`);

    // The runtime identity. Neither half is discoverable from the cluster, so
    // the catalog is the default for a client that states none, and an explicit
    // value from the client wins. The account/uid pairing belongs to the image
    // and is not checked here or anywhere else — the operator cannot see inside
    // the image, so a mismatch surfaces as a failed login rather than a
    // rejected spec (docs/design/devenv-images/decision.md).
    const published = devImageFor(image);

    // runAsUser 0 is the whole of a request to run as root: the controller then
    // serves and advertises "root" whatever spec.runtime.user says, reporting
    // the contradictory field as ignored. So a root environment states no
    // account at all, and takes gid 0 — a root uid beside the image's own gid
    // would chown the workspace to a group the root process does not use.
    const runAsRoot = body.runAsUser === 0;
    const user = runAsRoot ? undefined : body.runtimeUser || published?.user;
    const runAsGroup = runAsRoot ? 0 : body.runAsGroup ?? published?.runAsGroup;
    const runAsUser = body.runAsUser;
    const securityContext =
      runAsUser === undefined && runAsGroup === undefined
        ? undefined
        : {
            ...(runAsUser !== undefined ? { runAsUser } : {}),
            ...(runAsGroup !== undefined ? { runAsGroup } : {}),
          };
    const runtime =
      user === undefined && securityContext === undefined && env.length === 0 && args.length === 0
        ? undefined
        : {
            ...(user !== undefined ? { user } : {}),
            ...(securityContext ? { securityContext } : {}),
            ...(env.length ? { env } : {}),
            ...(args.length ? { args } : {}),
          };

    const cr = {
      apiVersion: `${GROUP}/${VERSION}`,
      kind: "DevEnvironment",
      metadata: { name: body.name, namespace: body.namespace },
      spec: {
        type: body.type,
        image,
        running: true,
        resources: {
          ...(gpuEnabled ? { gpu: { vendor: accelerator, count: gpuCount } } : {}),
          ...(body.cpu ? { cpu: body.cpu } : {}),
          ...(body.memory ? { memory: body.memory } : {}),
        },
        ...(runtime ? { runtime } : {}),
        ...(body.storageGi !== undefined
          ? { storage: { size: `${body.storageGi}Gi`, ...(workspacePath ? { mountPath: workspacePath } : {}) } }
          : {}),
        ...(volumes.length ? { volumes } : {}),
        ...(ports.length ? { ports } : {}),
        lifecycle: { idleTimeout },
      },
    };

    await co.createNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: body.namespace,
      plural: PLURAL_DEVENV,
      body: cr,
    });
    return Response.json({ created: true, name: body.name }, { status: 201 });
  } catch (err) {
    console.error("Failed to create dev environment:", err);
    return Response.json({ error: "Failed to create dev environment" }, { status: 500 });
  }
});

// ── start / stop (PATCH) ────────────────────────────────────────────────────

/**
 * PATCH /api/devenvironments
 *
 * Starts or stops one environment by setting its `spec.running`. Body:
 * `{ namespace, name, running: boolean }`. The change is sent as an RFC 6902
 * JSON-Patch array because the generated client pins
 * `Content-Type: application/json-patch+json` (an object body would be
 * rejected with a 400 decode error). The `add` operation replaces
 * `spec.running` when present and creates it when the resource omits it
 * (existing resources created before the field was added to the API).
 */
export const PATCH = withAuth(async (req) => {
  try {
    const body = (await req.json()) as { namespace?: string; name?: string; running?: boolean };
    if (!body.namespace || !body.name || typeof body.running !== "boolean") {
      return Response.json({ error: "namespace, name and running (boolean) are required" }, { status: 400 });
    }
    const co = getCustomObjectsClient();
    await co.patchNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: body.namespace,
      plural: PLURAL_DEVENV,
      name: body.name,
      // JSON-Patch `add`: replaces /spec/running when present, creates it when absent.
      body: [{ op: "add", path: "/spec/running", value: body.running }],
      fieldManager: "cubestack-web",
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.error("Failed to patch dev environment:", err);
    const status =
      (err as { statusCode?: number })?.statusCode === 403
        ? { error: "无权限修改开发环境(需要 patch 权限)", status: 403 }
        : { error: "Failed to update dev environment", status: 500 };
    return Response.json(status, { status: status.status });
  }
});

// ── delete (DELETE) ──────────────────────────────────────────────────────────

/**
 * DELETE /api/devenvironments
 *
 * Deletes one environment. Body: `{ namespace, name }`.
 */
export const DELETE = withAuth(async (req) => {
  try {
    const body = (await req.json()) as { namespace?: string; name?: string };
    if (!body.namespace || !body.name) {
      return Response.json({ error: "namespace and name are required" }, { status: 400 });
    }
    const co = getCustomObjectsClient();
    await co.deleteNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: body.namespace,
      plural: PLURAL_DEVENV,
      name: body.name,
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.error("Failed to delete dev environment:", err);
    const status =
      (err as { statusCode?: number })?.statusCode === 404
        ? { error: `环境不存在或已删除。`, status: 404 }
        : { error: "Failed to delete dev environment", status: 500 };
    return Response.json(status, { status: status.status });
  }
});