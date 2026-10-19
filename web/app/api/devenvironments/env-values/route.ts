import { getCustomObjectsClient, isNotFound } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler reads the live cluster, so it must not be prerendered.
export const dynamic = "force-dynamic";

// Operator CRD group/version/plural (see app/api/devenvironments/route.ts).
const GROUP = "ai.cubestack.io";
const VERSION = "v1alpha1";
const PLURAL_DEVENV = "devenvironments";

// Values can be credentials, so nothing on the path keeps a copy.
const NO_STORE = { "Cache-Control": "no-store" } as const;

const refuse = (code: string, status: number, params?: Record<string, string>) =>
  Response.json(params ? { error: code, params } : { error: code }, { status, headers: NO_STORE });

interface EnvVar {
  name?: string;
  value?: string;
}

/**
 * GET /api/devenvironments/env-values?namespace=<ns>&name=<env>
 *
 * The literal `spec.runtime.env` values of one environment. The list route
 * deliberately carries only names (and valueFrom sources): it spans every
 * namespace and goes to every authenticated caller, while an env value can be a
 * registry token. Here the request names one environment, so it can be answered
 * on demand and kept masked in the panel until the user asks to see it.
 *
 * Variables whose value comes from a Secret/ConfigMap are absent from the map:
 * their source is already on the summary, and their value is not in the CR.
 */
export const GET = withAuth(async (req) => {
  const params = new URL(req.url).searchParams;
  const namespace = (params.get("namespace") ?? "").trim();
  const name = (params.get("name") ?? "").trim();
  if (!namespace || !name) return refuse("requestInvalid", 400);

  let env: { spec?: { runtime?: { env?: EnvVar[] } } };
  try {
    const co = getCustomObjectsClient();
    env = (await co.getNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      plural: PLURAL_DEVENV,
      namespace,
      name,
    })) as typeof env;
  } catch (err) {
    if (isNotFound(err)) return refuse("nameMissing", 404, { name });
    console.error("Failed to read the dev environment:", err);
    return refuse("envUnreadable", 500);
  }

  const values: Record<string, string> = {};
  for (const v of env.spec?.runtime?.env ?? []) {
    if (v.name && typeof v.value === "string") values[v.name] = v.value;
  }
  return Response.json({ values }, { headers: NO_STORE });
});
