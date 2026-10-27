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
// The idle auto-stop mark the operator sets on an environment it has idled out.
// It is the whole of the stopped state: clearing it is what starts the environment
// again, which is the client's job (spec.running stays true throughout). The
// companion ai.cubestack.io/auto-stopped-at key is the controller's own record of
// when it stopped the environment, and it is a floor under the idle clock — the
// portal must not clear it.
const AUTO_STOPPED_ANNOTATION = "ai.cubestack.io/auto-stopped";

// The user's public keys, when the create request carries any: they are
// written to a per-environment Secret (created after the CR, owned by it) and
// spec.ssh.authorizedKeysSecret points at the entry the container mounts. The
// name stays clear of the operator's own managed Secrets (<name>-ssh-host-key,
// <name>-ssh-client-key, and the pre-split <name>-ssh-keys).
const SSH_KEYS_SECRET_SUFFIX = "-ssh-user-keys";
const SSH_KEYS_DATA_KEY = "authorized_keys";
// A pasted wall of keys is not an authorized_keys: the bound exists so the
// Secret cannot grow past the size a pod mount and the API server will accept.
const SSH_KEYS_MAX = 50;
// The one-line OpenSSH form: key type, base64 blob, optional comment — the
// shape `ssh-keygen` writes and ssh-copy-id appends.
const OPENSSH_PUB_KEY_RE =
  /^(ssh-(rsa|dss|ed25519|ed25519@openssh\.com)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp(256|384|521))@openssh\.com)\s+[A-Za-z0-9+/]{16,}={0,2}(\s+\S.*)?$/;

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
    // from the brand gate. `model` is null when the environment left the model
    // open, which is not the same as an empty model: the CRD rejects "" — an
    // unpinned environment may land on any node offering the vendor's card.
    gpu: { vendor: "nvidia" | "metax"; count: number; model: string | null } | null;
    cpu: string;
    memory: string;
  };
  // pvcRetention is what deleting the environment does to the workspace claim:
  // "delete" reclaims it, "retain" keeps it as workspace-<name>-0. Stated for
  // every environment that has a workspace, including the ones that never named
  // it — the CRD's default is delete, so an absent field reads as delete.
  storage: { size: string; mountPath: string | null; pvcRetention: "retain" | "delete" } | null;
  // spec.volumes: extra PVCs mounted alongside the workspace.
  volumes: Array<{ name: string; pvcName: string; mountPath: string; readOnly: boolean }>;
  // spec.runtime.env: the variable's name and, when it comes from a Secret or
  // ConfigMap, the source it reads. A literal value is not carried here — this
  // list spans every namespace and any authenticated caller can read it, and an
  // env value can be a credential. `hasValue` says one exists; the value itself
  // is fetched for one environment at a time (see env-values/route.ts) when its
  // detail panel opens.
  env: Array<{ name: string; hasValue: boolean; valueFrom: string | null }>;
  // spec.runtime.command and .args, as the argv they are. Both are projected in
  // full: neither can carry a credential the way an env value can.
  command: string[];
  args: string[];
  ports: Array<{ name: string; type: "http" | "tcp" | "udp"; containerPort: number }>;
  idleTimeout: number;
  sshEnabled: boolean;
  // spec.nodeSelector: the labels the environment pins its pod to. Empty for the
  // environments that state none, which is most of them — the accelerator
  // already decides where most pods can run.
  nodeSelector: Record<string, string>;
  // spec.network.egress.unrestricted: whether the environment may reach outside
  // the cluster. Stated for every environment, including the ones that never
  // asked — the CRD's default is restricted, and an absent network block reads
  // as restricted. It is the state that explains an install which raised nothing
  // and failed later on a missing import.
  egressUnrestricted: boolean;
  // observed state (phase is null until the controller reports it)
  phase: string | null;
  phaseReason: string | null;
  endpoints: Array<{ name: string; address: string }>;
  conditions: Array<{ type: string; status: string; reason: string; message: string }>;
  // The client keypair the controller minted for ssh login, so its owner can
  // retrieve the private half. Absent when spec.ssh.authorizedKeysSecret names
  // the user's own Secret — that holds public keys, not a client key.
  sshClientKeySecret: string | null;
  // The Secret a jupyter environment's access token lives in, recorded by the
  // controller. Null for every other type, which serves no authenticated web
  // path. Carries its namespace: the portal has no cluster-wide Secret read, so
  // it says where the token is rather than fetching it.
  jupyterTokenSecret: { name: string; namespace: string } | null;
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
  gpu?: { vendor?: string; count?: number; model?: string };
  cpu?: string;
  memory?: string;
}
interface EnvVarSource {
  secretKeyRef?: { name?: string; key?: string };
  configMapKeyRef?: { name?: string; key?: string };
  fieldRef?: { fieldPath?: string };
  resourceFieldRef?: { resource?: string };
}
interface DevEnvSpec {
  type?: string;
  image?: string;
  running?: boolean;
  resources?: DevEnvResources;
  storage?: { size?: string; mountPath?: string; pvcRetention?: string };
  volumes?: Array<{ name?: string; pvcName?: string; mountPath?: string; readOnly?: boolean }>;
  ports?: Array<{ name?: string; type?: string; containerPort?: number }>;
  runtime?: {
    env?: Array<{ name?: string; value?: string; valueFrom?: EnvVarSource }>;
    command?: string[];
    args?: string[];
  };
  lifecycle?: { idleTimeout?: number };
  nodeSelector?: Record<string, string>;
  network?: { egress?: { unrestricted?: boolean } };
  ssh?: { enabled?: boolean };
}
interface DevEnvStatus {
  phase?: { name?: string; reason?: string };
  endpoints?: Endpoint[];
  conditions?: Condition[];
  sshClientKeySecret?: { name?: string };
  jupyterTokenSecret?: { name?: string; namespace?: string };
}
interface DevEnv {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string; annotations?: Record<string, string> };
  spec?: DevEnvSpec;
  status?: DevEnvStatus;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** RFC 6901 JSON Pointer escape for an object key used in a patch path. */
function jsonPointerEscape(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Where a valueFrom env entry reads its value from, as one readable line. */
function envSource(v: EnvVarSource): string {
  const ref = (kind: string, r?: { name?: string; key?: string }) =>
    `${kind} ${r?.name ?? "?"}/${r?.key ?? "?"}`;
  if (v.secretKeyRef) return ref("secretKeyRef", v.secretKeyRef);
  if (v.configMapKeyRef) return ref("configMapKeyRef", v.configMapKeyRef);
  if (v.fieldRef) return `fieldRef ${v.fieldRef.fieldPath ?? "?"}`;
  if (v.resourceFieldRef) return `resourceFieldRef ${v.resourceFieldRef.resource ?? "?"}`;
  return "valueFrom";
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
      // does; an absent gpu block stays absent rather than becoming a GPU. An
      // absent model stays null: it is an open model, not an empty one.
      gpu: gpu
        ? { vendor: gpu.vendor === "metax" ? "metax" : "nvidia", count: num(gpu.count) || 1, model: gpu.model?.trim() || null }
        : null,
      cpu: spec.resources?.cpu ?? "—",
      memory: spec.resources?.memory ?? "—",
    },
    storage: spec.storage
      // A null mountPath is "not stated": the controller derives the path — and
      // the container's HOME — from the runtime identity, so the panel must not
      // invent "/workspace". A jupyter environment's workspace is /home/jovyan.
      ? {
          size: spec.storage.size ?? "10Gi",
          mountPath: spec.storage.mountPath?.trim() || null,
          // Anything that is not the CRD's other value is the default the
          // schema would have applied, including a field an older object never
          // carried: the delete path reads this, so it must never be "unknown".
          pvcRetention: spec.storage.pvcRetention === "retain" ? ("retain" as const) : ("delete" as const),
        }
      : null,
    volumes: (spec.volumes ?? []).map((v) => ({
      name: v.name ?? "",
      pvcName: v.pvcName ?? "",
      mountPath: v.mountPath ?? "",
      readOnly: v.readOnly ?? false,
    })),
    env: (spec.runtime?.env ?? [])
      .map((e) => ({
        name: e.name ?? "",
        hasValue: typeof e.value === "string",
        valueFrom: e.valueFrom ? envSource(e.valueFrom) : null,
      }))
      .filter((e) => e.name),
    command: spec.runtime?.command ?? [],
    args: spec.runtime?.args ?? [],
    ports: (spec.ports ?? []).map((p) => ({
      name: p.name ?? "",
      // The CRD's own default for an absent type.
      type: p.type === "tcp" || p.type === "udp" ? p.type : "http",
      containerPort: num(p.containerPort),
    })),
    idleTimeout: num(spec.lifecycle?.idleTimeout),
    sshEnabled: spec.ssh?.enabled ?? false,
    // The labels verbatim: there is no CRD default to apply and nothing to
    // derive, so an absent map stays empty rather than becoming a display value.
    nodeSelector: spec.nodeSelector ?? {},
    // Anything that is not true is the default the schema would have applied,
    // including a network block an older object never carried — the same way
    // pvcRetention resolves an absent field to the CRD's other value.
    egressUnrestricted: spec.network?.egress?.unrestricted === true,
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
    jupyterTokenSecret: status.jupyterTokenSecret?.name
      ? {
          name: status.jupyterTokenSecret.name,
          // The reference's own namespace is optional; the Secret is created
          // beside its environment, which is the fallback. Stating it here
          // rather than reusing the environment's keeps the retrieval command
          // correct if that ever stops being the same namespace.
          namespace: status.jupyterTokenSecret.namespace ?? env.metadata?.namespace ?? "",
        }
      : null,
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

// A DNS-1035 label, not a DNS-1123 one: name is the environment's Service name
// and its workload label value, and the operator's admission policy refuses
// anything a Service cannot be named (starting with a letter, at most 63
// characters). Validating it here turns that refusal into a field error.
const DNS_LABEL_RE = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
// spec.runtime.user's own validation, mirrored from the CRD
// (operator/api/v1alpha1/devenvironment_types.go: it is MaxLength=32 with
// Pattern ^[a-z_][a-z0-9_-]*$, enforced by the API server and nothing else).
const RUNTIME_USER_RE = /^[a-z_][a-z0-9_-]*$/;
const RUNTIME_USER_MAX = 32;
// Neither runAsUser nor runAsGroup is bounded in the CRD; nothing wider than an
// int32 is a uid or gid, and a value past it would be rejected by the API
// server as an opaque 422 rather than here.
const RUN_AS_ID_MAX = 2147483647;
// spec.lifecycle.idleTimeout is an int32 in seconds with no narrower bound in the
// CRD, so that is its ceiling: a larger value would reach the API server and come
// back as an opaque 422 the user cannot act on.
const IDLE_TIMEOUT_MAX = 2147483647;
const DEVENV_TYPES = ["jupyter", "ssh", "vscode"] as const;
// The accelerator is a single choice, "none" included, mirroring
// spec.resources.gpu.vendor plus the absence of the block.
const ACCELERATORS = ["none", "nvidia", "metax"] as const;
// spec.resources.gpu.model's own validation, mirrored from the CRD's markers
// (operator/api/v1alpha1/devenvironment_types.go): a malformed model is refused
// because no cluster could ever satisfy one, whereas a well-formed model that no
// node offers is a different matter — the spec is applied as written and the
// environment stays Pending. Which models exist is the cluster's business, not
// this route's, so only the shape is checked here.
const GPU_MODEL_RE = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const GPU_MODEL_MAX = 63;
// spec.nodeSelector's value here is a node's name, written into the
// kubernetes.io/hostname label the kubelet already sets on it, so it is bounded
// by what a label value may hold rather than by what a node name may. The CRD
// validates neither key nor value, so a malformed one is written and applied and
// only refused when the controller renders the pod — leaving the environment
// with no condition that names the label. The shape is checked here instead;
// which nodes exist is not, since that is the cluster's business.
const NODE_NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const NODE_NAME_MAX = 63;
// corev1.EnvVar.name's own validation, enforced by the API server and nothing
// else — an invalid name would surface as an opaque 422 on the CR, not here.
const ENV_NAME_RE = /^[-._a-zA-Z][-._a-zA-Z0-9]*$/;
const PORT_TYPES = ["http", "tcp", "udp"] as const;
// spec.network.rdmaType's own enum, mirrored from the CRD (roce is the default
// fabric; infiniband is the other choice the operator knows).
const RDMA_TYPES = ["roce", "infiniband"] as const;
// spec.storage.pvcRetention's own enum (delete is the default: the claim is
// provisioned for the environment, so it is reclaimed with it).
const PVC_RETENTIONS = ["retain", "delete"] as const;

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
  // spec.resources.gpu.model, in the vendor's own spelling — the value its
  // device plugin writes to the node label. Absent = any model of the vendor.
  gpuModel?: string;
  cpu?: string;
  memory?: string;
  storageGi?: number;
  // spec.storage.pvcRetention: what deleting the environment does to the
  // workspace claim. Absent = delete (the CRD's default), so only "retain" is
  // ever written — the body states the decision the user made, and leaving the
  // default unsaid keeps it the platform's default rather than the caller's.
  pvcRetention?: string; // → spec.storage.pvcRetention
  idleTimeout?: number;
  // The runtime identity (spec.runtime). All optional: a client that states
  // none gets the image catalog's identity, as before. Named after the CR's own
  // leaves, with the parent prefix the rest of this body already uses
  // (storageGi ← storage.size, gpuCount ← resources.gpu.count).
  runtimeUser?: string; // → spec.runtime.user
  runAsUser?: number; // → spec.runtime.securityContext.runAsUser
  runAsGroup?: number; // → spec.runtime.securityContext.runAsGroup
  // spec.runtime.sudo: passwordless sudo for the container's account. Absent /
  // false = no grant, the CRD's default, so only true is ever written. A root
  // container already has the privilege, so it is dropped there.
  sudo?: boolean;
  // Form-shaped where the UI is a single box, CR-named where the UI already
  // edits a CR leaf.
  mountPath?: string; // → spec.storage.mountPath (absent = derived)
  volumes?: Array<{ pvcName?: string; mountPath?: string }>; // → spec.volumes[] (name is derived here)
  env?: Array<{ name?: string; value?: string }>; // → spec.runtime.env[]
  command?: string; // → spec.runtime.command (one command line, split here)
  args?: string; // → spec.runtime.args (one command line, split here)
  ports?: Array<{ name?: string; containerPort?: number; type?: string }>; // → spec.ports[]
  // spec.network: RDMA access, and what the environment may reach on its own
  // behalf. rdmaEnabled gates the RDMA half; rdmaType names the fabric the
  // environment joins (roce is the CRD's default). Absent / false = no RDMA, so
  // the block is omitted rather than written as a false flag.
  rdmaEnabled?: boolean; // → spec.network.rdmaEnabled
  rdmaType?: string; // → spec.network.rdmaType
  // spec.network.egress.unrestricted: lifts the restriction on what the
  // environment may reach. Absent / false = restricted, the CRD's default, so
  // only true is ever written.
  egressUnrestricted?: boolean; // → spec.network.egress.unrestricted
  // spec.nodeSelector, which node to pin the pod to, named as the node itself —
  // the wizard offers the ones the cluster advertises. The route writes it as
  // the kubernetes.io/hostname label rather than taking the label map, so a
  // caller cannot name a label no node carries.
  nodeName?: string; // → spec.nodeSelector["kubernetes.io/hostname"]
  // spec.ssh: independent of the environment's type — ssh.enabled opens the SSH
  // endpoint on any type (a jupyter + ssh environment). Absent / false = no ssh
  // block (the type-ssh case is already exposed unconditionally by the operator).
  sshEnabled?: boolean; // → spec.ssh.enabled
  // The user's own OpenSSH public keys, one per line. Non-empty, the route
  // writes them to a <name>-ssh-user-keys Secret in the environment's namespace
  // and points spec.ssh.authorizedKeysSecret at it — that Secret's
  // data[authorized_keys] is the file the container mounts. Empty, the operator
  // mints a client keypair the owner retrieves through status.sshClientKeySecret.
  sshKeys?: string; // → <name>-ssh-user-keys Secret data[authorized_keys]
}

/**
 * POST /api/devenvironments
 *
 * Creates a DevEnvironment. Structural validation here (name/type/image/
 * resources), then the CR is written; the operator's controller and admission
 * webhooks re-validate on reconcile. When the request carries the user's own
 * public keys, a <name>-ssh-user-keys Secret is written in the same namespace
 * (owned by the CR) after the CR is. Requires RBAC to create the CR — and the
 * key Secret, when there are keys — in the target namespace.
 */
export const POST = withAuth(async (req) => {
  try {
    const body = (await req.json()) as CreateBody;
    // A rejected request carries a stable code plus the values its sentence
    // needs, and no prose of its own: the sentence lives in the portal's
    // dictionaries (`dev.err.<code>`, en / zh-CN / zh-TW), which is what the
    // console renders. The code still names what was refused to a caller that is
    // not the console — the route's own tests, curl, a future client.
    const ValidationError = (code: string, params?: Record<string, string | number>) =>
      Response.json({ error: code, params }, { status: 400 });

    if (!body.name || !DNS_LABEL_RE.test(body.name)) {
      return ValidationError("nameInvalid");
    }
    if (!body.namespace || !body.image?.trim()) {
      return ValidationError("namespaceImageRequired");
    }
    // Trimmed once and used for both the catalog lookup and the CR: a padded
    // reference is a different image to the registry, and looking the two up
    // separately is how a catalog image stops being recognized as one.
    const image = body.image.trim();
    if (!body.type || !(DEVENV_TYPES as readonly string[]).includes(body.type)) {
      return ValidationError("typeInvalid", { types: DEVENV_TYPES.join(" / ") });
    }
    // "none" omits spec.resources.gpu entirely: the CRD has no zero count, and
    // the absence of the block is what keeps the image out of the brand gate.
    const accelerator = body.accelerator ?? "none";
    if (!(ACCELERATORS as readonly string[]).includes(accelerator)) {
      return ValidationError("acceleratorInvalid", { values: ACCELERATORS.join(" / ") });
    }
    const gpuEnabled = accelerator !== "none";
    const gpuCount = body.gpuCount ?? 1;
    if (gpuEnabled && (!Number.isInteger(gpuCount) || gpuCount < 1 || gpuCount > 16)) {
      return ValidationError("gpuCountInvalid");
    }
    // Like the count, the model is read only when an accelerator is wanted:
    // "none" drops it the same way it drops the count, rather than refusing a
    // request whose spec ignores it.
    const gpuModel = body.gpuModel?.trim() ?? "";
    if (gpuEnabled && gpuModel && (gpuModel.length > GPU_MODEL_MAX || !GPU_MODEL_RE.test(gpuModel))) {
      return ValidationError("gpuModelInvalid", { max: GPU_MODEL_MAX });
    }
    if (body.storageGi !== undefined && (body.storageGi < 20 || body.storageGi > 800)) {
      return ValidationError("storageInvalid");
    }
    const idleTimeout = body.idleTimeout === undefined ? 0 : body.idleTimeout;
    if (!Number.isInteger(idleTimeout) || idleTimeout < 0 || idleTimeout > IDLE_TIMEOUT_MAX) {
      return ValidationError("idleTimeoutInvalid", { max: IDLE_TIMEOUT_MAX });
    }

    // The runtime identity. An empty account is "not stated", not an account:
    // spec.runtime.user is omitempty and does not match the CRD's own pattern,
    // so writing "" would be an API-server 422 the user cannot act on.
    if (body.runtimeUser) {
      if (body.runtimeUser.length > RUNTIME_USER_MAX || !RUNTIME_USER_RE.test(body.runtimeUser)) {
        return ValidationError("runtimeUserInvalid");
      }
      // Root is the one account whose uid the platform knows: the controller
      // serves and advertises "root" only at runAsUser 0, so asking for it at
      // any other uid describes an sshd that cannot serve the account it names.
      // Every other account/uid pairing is the image's to get right and is
      // unverifiable here (docs/design/devenv-images/decision.md).
      if (body.runtimeUser === "root" && body.runAsUser !== 0) {
        return ValidationError("rootAccountMismatch");
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
        return ValidationError("runAsIdInvalid", { field, max: RUN_AS_ID_MAX });
      }
    }

    // The workspace path. Left empty it is not stated at all: the controller then
    // derives the path — and the container's HOME — from the runtime identity,
    // and pinning it from here would move a jupyter environment's home off
    // /home/jovyan onto whatever this route guessed.
    const workspacePath = body.mountPath?.trim() ?? "";
    if (workspacePath && (!workspacePath.startsWith("/") || workspacePath === "/")) {
      return ValidationError("mountPathInvalid");
    }
    // spec.storage.mountPath exists only inside spec.storage: a path with no
    // claim behind it describes a mount nothing can honour, and the API server
    // would prune it rather than complain.
    if (workspacePath && body.storageGi === undefined) {
      return ValidationError("mountPathWithoutStorage");
    }
    // spec.storage.pvcRetention, like mountPath, exists only inside spec.storage:
    // a retention policy for a claim that was never asked for decides nothing.
    // "delete" is the CRD's default and is accepted, but only "retain" is
    // written — see the spec literal below.
    const pvcRetention = body.pvcRetention ?? "delete";
    if (!(PVC_RETENTIONS as readonly string[]).includes(pvcRetention)) {
      return ValidationError("pvcRetentionInvalid", { values: PVC_RETENTIONS.join(" / ") });
    }
    if (body.pvcRetention !== undefined && body.storageGi === undefined) {
      return ValidationError("pvcRetentionWithoutStorage");
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
        return ValidationError("volumeIncomplete");
      }
      if (!mountPath.startsWith("/") || mountPath === "/") {
        return ValidationError("volumePathInvalid", { path: mountPath });
      }
      if (mountedPaths.has(mountPath)) {
        return ValidationError("volumePathDuplicate", { path: mountPath });
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
      if (!name) return ValidationError("envNameRequired");
      if (!ENV_NAME_RE.test(name)) {
        return ValidationError("envNameInvalid", { name });
      }
      if (envNames.has(name)) return ValidationError("envNameDuplicate", { name });
      envNames.add(name);
      // HOME is not just another variable: an absolute one decides where the
      // workspace mounts (StorageSpec.MountPath), so a relative value would tell
      // the container its home is at a path that does not exist.
      if (name === "HOME" && !value.startsWith("/")) {
        return ValidationError("envHomeNotAbsolute");
      }
      env.push({ name, value });
    }

    // The entrypoint and its arguments are two separate overrides of the
    // image's own (command → ENTRYPOINT, args → CMD), so they are two boxes and
    // two errors: one shared message would point at the wrong field.
    const commandLine = body.command?.trim() ?? "";
    const command = commandLine ? splitArgs(commandLine) : [];
    if (command === null) return ValidationError("commandUnbalanced");

    const argsLine = body.args?.trim() ?? "";
    const args = argsLine ? splitArgs(argsLine) : [];
    if (args === null) return ValidationError("argsUnbalanced");

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
      if (!name) return ValidationError("portNameRequired");
      // The name is published in the sub path and in status.endpoints, so the
      // CRD requires it unique — stated in prose, not in the schema.
      if (portNames.has(name)) return ValidationError("portNameDuplicate", { name });
      if (!(PORT_TYPES as readonly string[]).includes(type)) {
        return ValidationError("portTypeInvalid", { types: PORT_TYPES.join(" / ") });
      }
      if (containerPort === undefined || !Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
        return ValidationError("portNumberInvalid");
      }
      if (type !== "http") {
        if (l4Ports.has(containerPort)) {
          return ValidationError("portInUse", { port: containerPort });
        }
        l4Ports.add(containerPort);
      }
      portNames.add(name);
      ports.push({ name, type, containerPort });
    }

    // spec.network: RDMA. The block is written only when rdmaEnabled; rdmaType
    // names the fabric and defaults to roce (the CRD's default). A fabric no
    // node advertises does not fail the write — the environment simply stays
    // Pending — so the value is checked for shape here, not for availability.
    const rdmaEnabled = body.rdmaEnabled === true;
    const rdmaType = body.rdmaType ?? "roce";
    if (rdmaEnabled && !(RDMA_TYPES as readonly string[]).includes(rdmaType)) {
      return ValidationError("rdmaTypeInvalid", { types: RDMA_TYPES.join(" / ") });
    }

    // spec.network.egress.unrestricted. Only the CRD's one non-default value is
    // ever written, so there is nothing to validate: false is the absence of the
    // field, exactly as it is for rdmaEnabled above.
    const egressUnrestricted = body.egressUnrestricted === true;

    // spec.nodeSelector: the node the pod is pinned to. Checked for shape, not
    // for existence — whether the node is one of the cluster's is not something
    // this route can be wrong about from the body alone.
    const nodeName = body.nodeName?.trim() ?? "";
    if (nodeName && (nodeName.length > NODE_NAME_MAX || !NODE_NAME_RE.test(nodeName))) {
      return ValidationError("nodeNameInvalid", { name: nodeName });
    }

    // spec.ssh: written only when sshEnabled (independent of type — a jupyter or
    // vscode environment can still expose SSH). Non-empty public keys are
    // written to <name>-ssh-user-keys and spec.ssh.authorizedKeysSecret points
    // at data[authorized_keys]; the operator then mounts that entry as the
    // container's authorized_keys. Empty keys leave the block to the operator,
    // which mints a client keypair the owner retrieves through
    // status.sshClientKeySecret.
    const sshEnabled = body.sshEnabled === true;
    let sshAuthorizedKeysSecret: { name: string; key: string } | undefined;
    let sshUserKeys = "";
    if (sshEnabled) {
      const lines = (body.sshKeys ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length > 0) {
        if (lines.length > SSH_KEYS_MAX) {
          return ValidationError("sshKeysTooMany", { max: SSH_KEYS_MAX });
        }
        for (const line of lines) {
          if (!OPENSSH_PUB_KEY_RE.test(line)) {
            return ValidationError("sshKeyInvalid");
          }
        }
        // The key Secret's name is derived from the CR's, and the suffix has to
        // fit in a DNS label beside it: a longer CR name is valid on its own,
        // so refuse here with a sentence rather than fail at the Secret write
        // with an opaque 422.
        if (body.name.length + SSH_KEYS_SECRET_SUFFIX.length > 63) {
          return ValidationError("nameTooLong", { max: 63 - SSH_KEYS_SECRET_SUFFIX.length });
        }
        sshUserKeys = lines.join("\n") + "\n";
        sshAuthorizedKeysSecret = { name: body.name + SSH_KEYS_SECRET_SUFFIX, key: SSH_KEYS_DATA_KEY };
      }
    }

    const core = getCoreClient();
    const co = getCustomObjectsClient();

    // Namespace must exist.
    const envelope = await core.listNamespace();
    const nsNames = new Set((envelope.items ?? []).map((ns) => ns.metadata?.name));
    if (!nsNames.has(body.namespace)) {
      return ValidationError("namespaceMissing", { namespace: body.namespace });
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
    if (exists) return ValidationError("nameTaken", { name: body.name });

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
    // The grant follows the container's non-root account: root already has the
    // privilege, so a request that states both is answered with root alone.
    const sudo = !runAsRoot && body.sudo === true;
    const securityContext =
      runAsUser === undefined && runAsGroup === undefined
        ? undefined
        : {
            ...(runAsUser !== undefined ? { runAsUser } : {}),
            ...(runAsGroup !== undefined ? { runAsGroup } : {}),
          };
    const runtime =
      user === undefined &&
      securityContext === undefined &&
      !sudo &&
      env.length === 0 &&
      command.length === 0 &&
      args.length === 0
        ? undefined
        : {
            ...(user !== undefined ? { user } : {}),
            ...(securityContext ? { securityContext } : {}),
            ...(sudo ? { sudo } : {}),
            ...(env.length ? { env } : {}),
            ...(command.length ? { command } : {}),
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
          // The model is written only when one was pinned: "any" is the absence
          // of the field, and an empty string would be a MinLength rejection.
          ...(gpuEnabled
            ? { gpu: { vendor: accelerator, count: gpuCount, ...(gpuModel ? { model: gpuModel } : {}) } }
            : {}),
          ...(body.cpu ? { cpu: body.cpu } : {}),
          ...(body.memory ? { memory: body.memory } : {}),
        },
        ...(runtime ? { runtime } : {}),
        ...(body.storageGi !== undefined
          ? {
              storage: {
                size: `${body.storageGi}Gi`,
                ...(workspacePath ? { mountPath: workspacePath } : {}),
                // Written only when the workspace is to outlive the environment:
                // "delete" is what the CRD applies anyway, and saying it here
                // would put the platform's default in the user's mouth.
                ...(pvcRetention === "retain" ? { pvcRetention } : {}),
              },
            }
          : {}),
        ...(volumes.length ? { volumes } : {}),
        ...(ports.length ? { ports } : {}),
        lifecycle: { idleTimeout },
        // Written when the environment asks for RDMA, for unrestricted egress, or
        // for both; each leaf independently, so asking for one never states the
        // other. Absence is still the one spelling of "off": a false rdmaEnabled
        // flag and an explicit egress.unrestricted=false are never sent for the
        // operator to interpret — the CRD applies the same false, and stating it
        // would put the platform's default in the user's mouth.
        ...(rdmaEnabled || egressUnrestricted
          ? {
              network: {
                ...(rdmaEnabled ? { rdmaEnabled: true, rdmaType } : {}),
                ...(egressUnrestricted ? { egress: { unrestricted: true } } : {}),
              },
            }
          : {}),
        // Written only when a node was picked: an empty selector selects nothing,
        // and the operator writes a nil nodeSelector rather than an empty one.
        ...(nodeName ? { nodeSelector: { "kubernetes.io/hostname": nodeName } } : {}),
        // Written only when sshEnabled: absence is the one spelling of "no ssh
        // switch", so a false flag is never sent. The type-ssh case is already
        // exposed unconditionally by the operator, so this block only carries
        // the explicit switch and the optional user-supplied key Secret.
        ...(sshEnabled
          ? {
              ssh: {
                enabled: true,
                ...(sshAuthorizedKeysSecret ? { authorizedKeysSecret: sshAuthorizedKeysSecret } : {}),
              },
            }
          : {}),
      },
    };

    const created = (await co.createNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: body.namespace,
      plural: PLURAL_DEVENV,
      body: cr,
    })) as { metadata?: { uid?: string } };

    // The keys Secret follows the CR rather than preceding it: created first it
    // would be orphaned by a failed CR write, and after — owned by the CR — it
    // is garbage-collected with the environment. The operator tolerates the
    // gap: it requeues on the missing Secret until this write lands.
    if (sshUserKeys && sshAuthorizedKeysSecret) {
      const uid = created?.metadata?.uid;
      try {
        await core.createNamespacedSecret({
          namespace: body.namespace,
          body: {
            metadata: {
              name: sshAuthorizedKeysSecret.name,
              namespace: body.namespace,
              // The controller owner is what collects the Secret when the
              // environment goes: a uid-less create answer (some client builds)
              // still yields a working environment, only the Secret outlives it.
              ...(uid
                ? {
                    ownerReferences: [
                      { apiVersion: `${GROUP}/${VERSION}`, kind: "DevEnvironment", name: body.name, uid, controller: true },
                    ],
                  }
                : {}),
            },
            type: "Opaque",
            data: { [SSH_KEYS_DATA_KEY]: Buffer.from(sshUserKeys, "utf8").toString("base64") },
          },
        });
      } catch (err) {
        // The environment exists but its keys are not: left alone, the operator
        // would requeue on a reference to a Secret that never appears. Unwind
        // the CR (best effort) and report the failure.
        console.error("Failed to create the ssh keys secret:", err);
        try {
          await co.deleteNamespacedCustomObject({
            group: GROUP,
            version: VERSION,
            namespace: body.namespace,
            plural: PLURAL_DEVENV,
            name: body.name,
          });
        } catch (delErr) {
          console.error("Failed to delete the dev environment after a keys secret failure:", delErr);
        }
        return Response.json({ error: "Failed to create dev environment" }, { status: 500 });
      }
    }
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
 *
 * Starting an auto-stopped environment also clears its
 * `ai.cubestack.io/auto-stopped` mark, which is the whole of the stopped
 * state — the operator never writes `spec.running` itself, so without the
 * clear the Start would change nothing and the controller would never wake.
 * The mark is removed only when present, because a JSON-Patch `remove` on an
 * absent path rejects the entire patch; the controller's own
 * `ai.cubestack.io/auto-stopped-at` record is left untouched, since clearing
 * it would re-introduce the idle re-mark the operator just fixed.
 */
export const PATCH = withAuth(async (req) => {
  try {
    const body = (await req.json()) as { namespace?: string; name?: string; running?: boolean };
    if (!body.namespace || !body.name || typeof body.running !== "boolean") {
      return Response.json({ error: "namespace, name and running (boolean) are required" }, { status: 400 });
    }
    const co = getCustomObjectsClient();
    const ops: Array<{ op: string; path: string; value?: unknown }> = [
      // JSON-Patch `add`: replaces /spec/running when present, creates it when absent.
      { op: "add", path: "/spec/running", value: body.running },
    ];
    if (body.running) {
      // Starting an auto-stopped environment requires clearing the mark, which
      // is the whole of the stopped state. A JSON-Patch `remove` on an absent
      // path rejects the entire patch, so only clear it when it is actually there.
      const current = (await co.getNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: body.namespace,
        plural: PLURAL_DEVENV,
        name: body.name,
      })) as DevEnv | undefined;
      if (current?.metadata?.annotations?.[AUTO_STOPPED_ANNOTATION]) {
        ops.push({ op: "remove", path: `/metadata/annotations/${jsonPointerEscape(AUTO_STOPPED_ANNOTATION)}` });
      }
    }
    await co.patchNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: body.namespace,
      plural: PLURAL_DEVENV,
      name: body.name,
      body: ops,
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
  // Held outside the try so the 404 below can name the object it could not find:
  // the sentence the console renders is built from it.
  let name = "";
  try {
    const body = (await req.json()) as { namespace?: string; name?: string };
    name = body.name ?? "";
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
        ? // The object was already gone. A code like the 400s, so the console can
          // say it in the user's language instead of a Chinese literal.
          { error: "nameMissing", params: { name }, status: 404 }
        : { error: "Failed to delete dev environment", status: 500 };
    return Response.json(status, { status: status.status });
  }
});