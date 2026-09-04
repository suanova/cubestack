import { getCoreClient, getCustomObjectsClient } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";

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
 * the read/display contract; everything is projected from the live cluster —
 * the prototype (web/public/devenv.html) is only the visual reference, never a
 * data source.
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
    gpuType: "nvidia" | "metax";
    gpuCount: number;
    cpu: string;
    memory: string;
  };
  storage: { size: string; mountPath: string } | null;
  idleTimeout: number;
  sshEnabled: boolean;
  // observed state (phase is null until the controller reports it)
  phase: string | null;
  phaseReason: string | null;
  endpoints: Array<{ name: string; address: string }>;
  conditions: Array<{ type: string; status: string; reason: string; message: string }>;
  sshKeysSecret: string | null;
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
  gpuType?: string;
  gpuCount?: number;
  cpu?: string;
  memory?: string;
}
interface DevEnvSpec {
  type?: string;
  image?: string;
  running?: boolean;
  resources?: DevEnvResources;
  storage?: { size?: string; mountPath?: string };
  lifecycle?: { idleTimeout?: number };
  ssh?: { enabled?: boolean };
}
interface DevEnvStatus {
  phase?: { name?: string; reason?: string };
  endpoints?: Endpoint[];
  conditions?: Condition[];
  sshKeysSecret?: { name?: string };
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
  return {
    name: env.metadata?.name ?? "?",
    namespace: env.metadata?.namespace ?? "",
    createdAt: env.metadata?.creationTimestamp ?? null,
    type: (spec.type === "jupyter" || spec.type === "ssh" || spec.type === "vscode" ? spec.type : "ssh"),
    image: spec.image ?? "—",
    running: spec.running ?? false,
    resources: {
      gpuType: spec.resources?.gpuType === "metax" ? "metax" : "nvidia",
      gpuCount: num(spec.resources?.gpuCount) || 1,
      cpu: spec.resources?.cpu ?? "—",
      memory: spec.resources?.memory ?? "—",
    },
    storage: spec.storage
      ? { size: spec.storage.size ?? "10Gi", mountPath: spec.storage.mountPath ?? "/workspace" }
      : null,
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
    sshKeysSecret: status.sshKeysSecret?.name ?? null,
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
const DEVENV_TYPES = ["jupyter", "ssh", "vscode"] as const;

interface CreateBody {
  namespace?: string;
  name?: string;
  type?: string;
  image?: string;
  gpuType?: string;
  gpuCount?: number;
  cpu?: string;
  memory?: string;
  storageGi?: number;
  idleTimeout?: number;
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
    if (!body.namespace || !body.image) {
      return ValidationError("namespace、image 均为必填。");
    }
    if (!body.type || !(DEVENV_TYPES as readonly string[]).includes(body.type)) {
      return ValidationError(`type 必须为 ${DEVENV_TYPES.join(" / ")} 之一。`);
    }
    const gpuType = body.gpuType === "metax" || body.gpuType === "nvidia" ? body.gpuType : "nvidia";
    const gpuCount = body.gpuCount;
    if (gpuCount === undefined || !Number.isInteger(gpuCount) || gpuCount < 1 || gpuCount > 16) {
      return ValidationError("gpuCount 需为 1–16 之间的整数。");
    }
    if (body.storageGi !== undefined && (body.storageGi < 20 || body.storageGi > 800)) {
      return ValidationError("storageGi 需在 20–800 之间。");
    }
    const idleTimeout = body.idleTimeout === undefined ? 0 : body.idleTimeout;
    if (!Number.isInteger(idleTimeout) || idleTimeout < 0) {
      return ValidationError("idleTimeout 需为非负整数(秒)。");
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

    const cr = {
      apiVersion: `${GROUP}/${VERSION}`,
      kind: "DevEnvironment",
      metadata: { name: body.name, namespace: body.namespace },
      spec: {
        type: body.type,
        image: body.image,
        running: true,
        resources: {
          gpuType,
          gpuCount,
          ...(body.cpu ? { cpu: body.cpu } : {}),
          ...(body.memory ? { memory: body.memory } : {}),
        },
        storage: body.storageGi !== undefined ? { size: `${body.storageGi}Gi` } : undefined,
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
 * `{ namespace, name, running: boolean }`. A merge-patch body is used (an
 * object, not a JSON-Patch array) so `spec.running` is created when the listed
 * resource omits it (existing resources created before the field was added to
 * the API), instead of `replace`, which would fail when the target is absent.
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
      // application/json merge-patch semantics: creates /spec/running if absent.
      body: { spec: { running: body.running } },
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