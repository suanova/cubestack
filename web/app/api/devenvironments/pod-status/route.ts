import { getCoreClient, getCustomObjectsClient, isNotFound } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler reads the live cluster, so it must not be prerendered.
export const dynamic = "force-dynamic";

// Operator CRD group/version/plural (see app/api/devenvironments/route.ts).
const GROUP = "ai.cubestack.io";
const VERSION = "v1alpha1";
const PLURAL_DEVENV = "devenvironments";

// The label the controller puts on every pod it creates for an environment
// (operator/internal/controller/assets.go: devEnvironmentLabelKey). It is how
// the pod is found without naming one.
const ENV_LABEL = "ai.cubestack.io/dev-environment";

// The answer is live cluster state: a cached copy would keep a reason the user
// has already fixed.
const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * A refusal the console renders from its dictionaries (see lib/api-error.ts).
 * `params` travels with the code because the sentences interpolate.
 */
const refuse = (code: string, status: number, params?: Record<string, string>) =>
  Response.json(params ? { error: code, params } : { error: code }, { status, headers: NO_STORE });

/**
 * Why an environment's pod is not up, in the kubelet's own words.
 *
 * The DevEnvironment's conditions stop where the controller's knowledge stops:
 * a container that cannot pull its image, crashes on start or is OOM-killed is
 * reported on the pod, never on the CR, and the pod also carries the scheduler's
 * message when it could not be placed at all.
 */
export interface PodFailure {
  /** The container the reason belongs to; absent when the pod itself is the reason. */
  container?: string;
  /** The kubelet's enum — ImagePullBackOff, CrashLoopBackOff, OOMKilled, Error … — verbatim. */
  reason: string;
  /** The kubelet's message, verbatim: it is the text that names the cause. */
  message?: string;
  /** The exit code of the run that failed, when there was one. */
  exitCode?: number;
}

export interface PodStatusResponse {
  /** Null while the pod is fine, still starting, or not created yet. */
  failure: PodFailure | null;
}

// The pod fields this route reads, stated structurally rather than importing
// the client's generated types: the payload crosses into the console, and only
// these fields leave.
interface ContainerState {
  waiting?: { reason?: string; message?: string };
  terminated?: { reason?: string; message?: string; exitCode?: number };
}

interface ContainerStatus {
  name: string;
  state?: ContainerState;
  lastState?: ContainerState;
}

interface Pod {
  metadata?: { name?: string; creationTimestamp?: string | Date };
  status?: {
    reason?: string;
    message?: string;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    initContainerStatuses?: ContainerStatus[];
    containerStatuses?: ContainerStatus[];
  };
}

/**
 * One container's failure, or null when it has none.
 *
 * `zeroExitIsSuccess` separates the two kinds: an init container that exited 0
 * finished its job, while an app container has no successful end state — the
 * pod's restart policy always brings it back, so its exit *is* the problem.
 */
function failureOf(cs: ContainerStatus, container: string, zeroExitIsSuccess: boolean): PodFailure | null {
  const waiting = cs.state?.waiting;
  if (waiting?.reason) {
    // The two states every container passes through on its way up. Reporting
    // them would put a failure line under a pod that is simply starting.
    if (waiting.reason === "ContainerCreating" || waiting.reason === "PodInitializing") return null;
    // CrashLoopBackOff's own message is a back-off countdown. The exit code of
    // the run that crashed is the fact behind it (137 → OOMKilled).
    return {
      container,
      reason: waiting.reason,
      message: waiting.message,
      exitCode: cs.lastState?.terminated?.exitCode,
    };
  }
  const terminated = cs.state?.terminated;
  if (terminated?.reason && !(zeroExitIsSuccess && terminated.exitCode === 0)) {
    return { container, reason: terminated.reason, message: terminated.message, exitCode: terminated.exitCode };
  }
  return null;
}

/**
 * The one failure worth showing, or null.
 *
 * Init containers first: a pod whose init container cannot start never reaches
 * its app containers, so their waiting states would describe a second problem
 * caused by the first.
 */
function podFailure(pod: Pod): PodFailure | null {
  const status = pod.status;
  for (const cs of status?.initContainerStatuses ?? []) {
    const failure = failureOf(cs, cs.name, true);
    if (failure) return failure;
  }
  for (const cs of status?.containerStatuses ?? []) {
    const failure = failureOf(cs, cs.name, false);
    if (failure) return failure;
  }
  // Nothing to blame on a container: a scheduler that could not place the pod
  // is the reason an environment stays Pending, and it is on the condition
  // rather than on any container. An eviction or a lost node states its reason
  // on the pod itself.
  const scheduled = status?.conditions?.find((c) => c.type === "PodScheduled" && c.status === "False");
  if (scheduled?.message) return { reason: scheduled.reason ?? "Unschedulable", message: scheduled.message };
  if (status?.reason) return { reason: status.reason, message: status.message };
  return null;
}

/** The newest pod of a set: during a roll a terminating one is still listed. */
function newestPod(pods: Pod[]): Pod | null {
  let newest: Pod | null = null;
  for (const pod of pods) {
    const at = pod.metadata?.creationTimestamp;
    const current = newest?.metadata?.creationTimestamp;
    if (newest === null || (at && current && new Date(at) > new Date(current))) newest = pod;
  }
  return newest;
}

/**
 * GET /api/devenvironments/pod-status?namespace=<ns>&name=<env>
 *
 * Why the environment's pod is not up, so the status card can say
 * "CrashLoopBackOff" instead of leaving the user to run kubectl for the one
 * fact the console cannot show.
 *
 * The pod is *derived*, never named by the caller, the way the sibling routes
 * derive their Secret: the request identifies a DevEnvironment, and the pod is
 * the one carrying the label the controller puts on that environment's pods.
 * There is no pod-name parameter to abuse, and the selector cannot reach a pod
 * the platform did not create for this environment.
 *
 * An environment that has no pod yet — stopped, or not yet reconciled — is not
 * an error: it answers failure: null, which the card renders as nothing.
 */
export const GET = withAuth(async (req) => {
  const params = new URL(req.url).searchParams;
  const namespace = (params.get("namespace") ?? "").trim();
  const name = (params.get("name") ?? "").trim();
  if (!namespace || !name) return refuse("requestInvalid", 400);

  let podNamespace: string;
  try {
    const co = getCustomObjectsClient();
    // Read the environment first: a name that is not an environment must not
    // answer "no failure", which reads as "nothing is wrong".
    const env = (await co.getNamespacedCustomObject({ group: GROUP, version: VERSION, plural: PLURAL_DEVENV, namespace, name })) as {
      metadata?: { namespace?: string };
    };
    if (!env?.metadata) return refuse("nameMissing", 404, { name });
    podNamespace = env.metadata.namespace ?? namespace;
  } catch (err) {
    if (isNotFound(err)) return refuse("nameMissing", 404, { name });
    console.error("Failed to read the dev environment:", err);
    return refuse("podUnreadable", 500);
  }

  try {
    const core = getCoreClient();
    const res = await core.listNamespacedPod({
      namespace: podNamespace,
      labelSelector: `${ENV_LABEL}=${name}`,
    });
    const pod = newestPod((res.items ?? []) as Pod[]);
    const body: PodStatusResponse = { failure: pod ? podFailure(pod) : null };
    return Response.json(body, { headers: NO_STORE });
  } catch (err) {
    console.error("Failed to read the dev environment pod:", err);
    return refuse("podUnreadable", 500);
  }
});
