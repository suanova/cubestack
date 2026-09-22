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
  storage: { size: string; mountPath: string } | null;
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
const DEVENV_TYPES = ["jupyter", "ssh", "vscode"] as const;
// The accelerator is a single choice, "none" included, mirroring
// spec.resources.gpu.vendor plus the absence of the block.
const ACCELERATORS = ["none", "nvidia", "metax"] as const;

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

    // The image decides the account the environment runs as and, for the
    // stock-derived jupyter image, the gid. Neither is discoverable from the
    // cluster, so it is resolved here from the catalog rather than taken from
    // the client. An image the platform does not publish resolves to nothing,
    // leaving spec.runtime unset and the CRD's own defaults in force.
    const published = devImageFor(body.image);
    const runtime = published
      ? {
          user: published.user,
          ...(published.runAsGroup !== undefined
            ? { securityContext: { runAsGroup: published.runAsGroup } }
            : {}),
        }
      : undefined;

    const cr = {
      apiVersion: `${GROUP}/${VERSION}`,
      kind: "DevEnvironment",
      metadata: { name: body.name, namespace: body.namespace },
      spec: {
        type: body.type,
        image: body.image,
        running: true,
        resources: {
          ...(gpuEnabled ? { gpu: { vendor: accelerator, count: gpuCount } } : {}),
          ...(body.cpu ? { cpu: body.cpu } : {}),
          ...(body.memory ? { memory: body.memory } : {}),
        },
        ...(runtime ? { runtime } : {}),
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