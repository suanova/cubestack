/**
 * The user environment-variable model shared by the InferenceService API
 * routes and the console. The rules mirror the operator CRD/VAP (backend
 * #508): explicit roles, literal values, reserved names rejected, and one
 * value per variable name within a role.
 */
export interface EnvVar {
  name: string;
  value: string;
  roles: string[];
}

export interface EnvError {
  code: string;
  params?: Record<string, string | number>;
}

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const RESERVED_PREFIXES = ["KUBERNETES_", "CUBESTACK_"];
const RESERVED_NAMES = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "BASH_ENV",
]);

export const MAX_ENV_ENTRIES = 64;
export const MAX_ENV_NAME = 256;
export const MAX_ENV_VALUE = 8192;
export const MAX_ENV_ROLES = 16;

/**
 * Validates user environment entries against the profile's roles. Returns the
 * first violation (the form shows one message at a time), or null.
 */
export function envError(env: EnvVar[], roles: string[]): EnvError | null {
  if (env.length > MAX_ENV_ENTRIES) {
    return { code: "envTooLong", params: { max: MAX_ENV_ENTRIES } };
  }

  const known = new Set(roles);
  for (const entry of env) {
    // Untrusted JSON: the TypeScript shape does not survive the wire, so a
    // malformed payload must be a 400 (not a 500 from reading .length/.startsWith).
    const raw = entry as unknown as { name?: unknown; value?: unknown; roles?: unknown };
    if (
      typeof raw.name !== "string" ||
      typeof raw.value !== "string" ||
      !Array.isArray(raw.roles) ||
      !raw.roles.every((role) => typeof role === "string")
    ) {
      return { code: "envNameInvalid", params: { name: "" } };
    }
    if (!entry.name || entry.name.length > MAX_ENV_NAME || !ENV_NAME_RE.test(entry.name)) {
      return { code: "envNameInvalid", params: { name: entry.name } };
    }
    if (RESERVED_PREFIXES.some((prefix) => entry.name.startsWith(prefix)) || RESERVED_NAMES.has(entry.name)) {
      return { code: "envNameReserved", params: { name: entry.name } };
    }
    if (entry.value.length > MAX_ENV_VALUE) {
      return { code: "envTooLong", params: { max: MAX_ENV_VALUE } };
    }
    if (!Array.isArray(entry.roles) || entry.roles.length === 0) {
      return { code: "envRoleRequired", params: { name: entry.name } };
    }
    if (entry.roles.length > MAX_ENV_ROLES) {
      return { code: "envTooLong", params: { max: MAX_ENV_ROLES } };
    }
    for (const role of entry.roles) {
      if (!known.has(role)) {
        return { code: "envRoleUnknown", params: { name: entry.name, role } };
      }
    }
  }

  // A variable may repeat across disjoint role sets (different values per
  // role); overlapping role sets would render twice into the same container.
  for (let i = 0; i < env.length; i++) {
    for (let j = i + 1; j < env.length; j++) {
      if (env[i].name !== env[j].name) continue;
      const overlap = env[i].roles.find((role) => env[j].roles.includes(role));
      if (overlap) {
        return { code: "envDuplicate", params: { name: env[i].name, role: overlap } };
      }
    }
  }

  return null;
}
