// Where the portal's branding lives and who may change it, read from the
// environment. The chart creates the ConfigMap and grants the pod get/patch on
// exactly that name; PORTAL_ADMIN_USERS is the username allowlist because
// sessions carry no roles (see lib/auth).

/** ConfigMap holding the logo the settings page uploads. */
export function brandingConfigMapName(): string {
  return process.env.BRANDING_CONFIGMAP_NAME ?? "cubestack-portal-branding";
}

/** Namespace of that ConfigMap (the release namespace). */
export function brandingConfigMapNamespace(): string {
  return process.env.BRANDING_CONFIGMAP_NAMESPACE ?? "cubestack-system";
}

/**
 * Usernames allowed to change branding. Empty when unset, which means nobody
 * can edit — the settings entry stays hidden for every user.
 */
export function brandingAdmins(): string[] {
  return (process.env.PORTAL_ADMIN_USERS ?? "")
    .split(",")
    .map((user) => user.trim())
    .filter(Boolean);
}

export function canEditBranding(user: string): boolean {
  return brandingAdmins().includes(user);
}
