import { getCoreClient, getCustomObjectsClient } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler talks to the live cluster, so it must not be prerendered.
export const dynamic = "force-dynamic";

const GROUP = "ai.cubestack.io";
const VERSION = "v1alpha1";

/**
 * Catalog the create-wizard needs, read from the live cluster in one snapshot:
 * the namespaces you can deploy into, the runtimes (InferenceRuntimeProfile),
 * and the model versions (ModelVersion) you can serve. The profile projection
 * carries its declared overrides so the wizard can render the right inputs
 * (number with min/max, select from enum, default) and pre-flight compatibility.
 */
export interface CreateOptionsResponse {
  namespaces: Array<{ name: string }>;
  profiles: Array<{
    name: string;
    engine: string | null;
    engineVersion: string | null;
    vendor: string | null;
    models: string[];
    architectures: string[];
    quantizations: string[];
    gpuPerPod: number | null;
    overrides: Array<{
      name: string;
      type: "integer" | "string" | "boolean";
      min: number | null;
      max: number | null;
      enum: Array<number | string> | null;
      default: number | string | boolean | null;
      description: string | null;
    }>;
  }>;
  modelversions: Array<{
    name: string;
    model: string | null;
    version: string | null;
    architecture: string | null;
    quantization: string | null;
  }>;
}

interface ProfileOverride {
  name?: string;
  type?: "integer" | "string" | "boolean";
  min?: number;
  max?: number;
  enum?: Array<number | string>;
  default?: number | string | boolean;
  description?: string;
}
interface ProfileRole {
  podTemplate?: { resources?: { gpuPerPod?: number } };
}
interface ProfileSpec {
  engine?: { name?: string; version?: string };
  accelerator?: { vendor?: string; models?: string[] };
  modelRequirements?: { architectures?: string[]; quantization?: string[] };
  overrides?: ProfileOverride[];
  roles?: ProfileRole[];
}
interface Profile {
  metadata?: { name?: string };
  spec?: ProfileSpec;
}
interface ModelVersion {
  metadata?: { name?: string };
  spec?: {
    model?: string;
    version?: string;
    architecture?: string;
    quantization?: string;
  };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export const GET = withAuth(async () => {
  try {
    const core = getCoreClient();
    const co = getCustomObjectsClient();

    const [nsRes, profileRes, mvRes] = await Promise.all([
      core.listNamespace(),
      co.listClusterCustomObject({ group: GROUP, version: VERSION, plural: "inferenceruntimeprofiles" }),
      co.listClusterCustomObject({ group: GROUP, version: VERSION, plural: "modelversions" }),
    ]);

    const profiles: Profile[] = profileRes.items ?? [];
    const modelversions: ModelVersion[] = mvRes.items ?? [];

    const response: CreateOptionsResponse = {
      namespaces: (nsRes.items ?? [])
        .map((ns) => ns.metadata?.name)
        .filter((n): n is string => Boolean(n))
        .sort()
        .map((name) => ({ name })),
      profiles: profiles.map((p) => {
        const spec = p.spec ?? {};
        const gpuPerPod = spec.roles?.reduce(
          (acc, r) => Math.max(acc, r.podTemplate?.resources?.gpuPerPod ?? 0),
          0,
        );
        return {
          name: p.metadata?.name ?? "?",
          engine: spec.engine?.name ?? null,
          engineVersion: spec.engine?.version ?? null,
          vendor: spec.accelerator?.vendor ?? null,
          models: spec.accelerator?.models ?? [],
          architectures: spec.modelRequirements?.architectures ?? [],
          quantizations: spec.modelRequirements?.quantization ?? [],
          gpuPerPod: gpuPerPod || 0,
          overrides: (spec.overrides ?? []).map((o) => ({
            name: o.name ?? "",
            type: o.type ?? "integer",
            min: num(o.min),
            max: num(o.max),
            enum: o.enum ?? null,
            default:
              o.default !== undefined
                ? (o.default as number | string | boolean)
                : null,
            description: o.description ?? null,
          })),
        };
      }),
      modelversions: modelversions.map((mv) => ({
        name: mv.metadata?.name ?? "?",
        model: mv.spec?.model ?? null,
        version: mv.spec?.version ?? null,
        architecture: mv.spec?.architecture ?? null,
        quantization: mv.spec?.quantization ?? null,
      })),
    };

    return Response.json(response);
  } catch (err) {
    console.error("Failed to load inference-service create options:", err);
    return Response.json({ error: "Failed to load create options" }, { status: 500 });
  }
});