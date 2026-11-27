import type { NextRequest } from "next/server";

import { sessionCookieName } from "@/lib/auth/config";
import { withAuth } from "@/lib/auth/guard";
import { verifySession } from "@/lib/auth/session";
import { getCoreClient, isNotFound } from "@/lib/kubernetes";
import { brandingConfigMapName, brandingConfigMapNamespace, canEditBranding } from "@/lib/settings/branding";
import { isValidLogo } from "@/lib/settings/logo";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// Reads/writes the live cluster, so it must not be prerendered.
export const dynamic = "force-dynamic";

/** Longest brand name / subtitle we store. */
const TEXT_MAX = 64;

type Branding = { logo: string | null; title: string | null; subtitle: string | null };
type BrandingUpdate = Partial<Branding>;
type ConfigMapData = { data?: { [key: string]: string } };

const EMPTY: Branding = { logo: null, title: null, subtitle: null };

/** Whether a client call failed because the object is already there. */
function isConflict(err: unknown): boolean {
  const e = err as { code?: number | string; statusCode?: number } | null;
  return e?.code === 409 || e?.statusCode === 409;
}

function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readBranding(cm: ConfigMapData): Branding {
  return {
    logo: cm.data?.logo || null,
    title: cm.data?.title || null,
    subtitle: cm.data?.subtitle || null,
  };
}

/** The stored branding, or the defaults when the ConfigMap is absent. */
async function loadBranding(): Promise<Branding> {
  try {
    return readBranding(
      await getCoreClient().readNamespacedConfigMap({
        name: brandingConfigMapName(),
        namespace: brandingConfigMapNamespace(),
      }),
    );
  } catch (err) {
    if (isNotFound(err)) return EMPTY;
    throw err;
  }
}

/** Field-by-field view after applying an update to an existing (or absent) ConfigMap. */
function applyUpdate(cm: ConfigMapData | null, update: BrandingUpdate): Branding {
  const data = cm?.data ?? {};
  const pick = (key: keyof Branding): string | null =>
    key in update ? (update[key] ?? null) : (data[key] || null);
  return { logo: pick("logo"), title: pick("title"), subtitle: pick("subtitle") };
}

/**
 * JSON Patch operations for the requested fields.
 *
 * The generated client sends `application/json-patch+json` by default (see the
 * llms/tasks routes), so a merge-patch object body is rejected by the API
 * server. A cleared value is a `remove` op: a null ConfigMap value is not
 * valid. When the ConfigMap has no `data` map at all, the whole object is
 * added once instead of patching individual keys under a nonexistent parent.
 */
function brandingPatchOps(cm: ConfigMapData, update: BrandingUpdate): object[] {
  const entries = Object.entries(update) as [keyof Branding, string | null][];
  if (!cm.data) {
    const data: { [key: string]: string } = {};
    for (const [key, value] of entries) if (value !== null) data[key] = value;
    return Object.keys(data).length > 0 ? [{ op: "add", path: "/data", value: data }] : [];
  }

  const ops: object[] = [];
  for (const [key, value] of entries) {
    if (value === null) {
      if (cm.data[key] !== undefined) ops.push({ op: "remove", path: `/data/${key}` });
    } else if (cm.data[key] !== value) {
      ops.push({ op: "add", path: `/data/${key}`, value });
    }
  }
  return ops;
}

/** The ConfigMap `data` for a brand-new object, omitting cleared fields. */
function createData(update: BrandingUpdate): { [key: string]: string } {
  const data: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(update) as [keyof Branding, string | null][]) {
    if (value !== null) data[key] = value;
  }
  return data;
}

/**
 * Parse the PUT body. A missing field leaves that part of the branding
 * unchanged; null (or a blank string for text) restores its default.
 */
function parseUpdate(body: unknown): BrandingUpdate | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(raw, key);
  if (!has("logo") && !has("title") && !has("subtitle")) return null;

  const update: BrandingUpdate = {};
  if (has("logo")) {
    const value = raw.logo;
    if (value !== null && (typeof value !== "string" || !isValidLogo(value))) return null;
    update.logo = value;
  }
  for (const key of ["title", "subtitle"] as const) {
    if (!has(key)) continue;
    const value = raw[key];
    if (value === null) {
      update[key] = null;
      continue;
    }
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (text.length > TEXT_MAX || /[\u0000-\u001f\u007f]/.test(text)) return null;
    update[key] = text || null;
  }
  return update;
}

// GET /api/settings/branding
// Public: the login page paints the logo and wordmark before anyone is signed
// in, so this endpoint deliberately skips the session guard. It returns only
// branding, and `canEdit` is false for an anonymous caller. The settings page
// uses canEdit to decide whether to offer the edit controls.
export async function GET(req: NextRequest) {
  const token = req.cookies.get(sessionCookieName())?.value;
  const session = token ? await verifySession(token) : null;
  try {
    return Response.json({
      ...(await loadBranding()),
      canEdit: session ? canEditBranding(session.user) : false,
    });
  } catch (err) {
    return Response.json(
      { error: "brandingLoadFailed", params: { error: failureMessage(err) } },
      { status: 500 },
    );
  }
}

// PUT /api/settings/branding
// Body { logo?, title?, subtitle? }. A data URL replaces the logo; null (or a
// blank text value) restores that field's default. Only PORTAL_ADMIN_USERS may
// write.
export const PUT = withAuth(async (req, session) => {
  if (!canEditBranding(session.user)) {
    return Response.json({ error: "brandingForbidden" }, { status: 403 });
  }

  const update = parseUpdate(await req.json().catch(() => null));
  if (update === null) {
    return Response.json({ error: "brandingInvalid" }, { status: 400 });
  }

  const name = brandingConfigMapName();
  const namespace = brandingConfigMapNamespace();
  try {
    let existing: ConfigMapData | null = null;
    try {
      existing = await getCoreClient().readNamespacedConfigMap({ name, namespace });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    if (existing === null) {
      const data = createData(update);
      if (Object.keys(data).length > 0) {
        try {
          await getCoreClient().createNamespacedConfigMap({
            namespace,
            body: {
              metadata: { name, labels: { "app.kubernetes.io/managed-by": "cubestack-portal" } },
              data,
            },
          });
        } catch (createErr) {
          // A concurrent save created it between read and write.
          if (!isConflict(createErr)) throw createErr;
          const cm = await getCoreClient().readNamespacedConfigMap({ name, namespace });
          const ops = brandingPatchOps(cm, update);
          if (ops.length > 0) {
            await getCoreClient().patchNamespacedConfigMap({ name, namespace, body: ops });
          }
        }
      }
      return Response.json({ ...applyUpdate(null, update), canEdit: true });
    }

    const ops = brandingPatchOps(existing, update);
    if (ops.length > 0) {
      await getCoreClient().patchNamespacedConfigMap({ name, namespace, body: ops });
    }
    return Response.json({ ...applyUpdate(existing, update), canEdit: true });
  } catch (err) {
    return Response.json(
      { error: "brandingSaveFailed", params: { error: failureMessage(err) } },
      { status: 500 },
    );
  }
});
