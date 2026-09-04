import { compareSync } from "bcryptjs";

import { getCoreClient } from "@/lib/kubernetes";
import { htpasswdSecretKey, htpasswdSecretName, htpasswdSecretNamespace } from "./config";

// htpasswd credential backend. Credentials live in a Kubernetes Secret whose
// data key holds an htpasswd file: one `user:hash` line per entry, where hash
// is a bcrypt hash ($2a$/$2b$/$2y$). The Secret is read through the Kubernetes
// API (name/namespace/data-key configurable via env) and parsed + cached for a
// short window so login attempts don't hammer the API.

interface LoadedHtpasswd {
  /** user -> bcrypt hash. */
  entries: Map<string, string>;
  /** ms epoch at which this snapshot was fetched. */
  loadedAt: number;
}

const TTL_MS = 30_000;
let cache: LoadedHtpasswd | null = null;

/**
 * Load and parse the htpasswd Secret. Throws a descriptive Error when the
 * Secret is missing/unreadable or has no usable entries — callers turn that
 * into a user-facing "auth not configured" 500, not a crash.
 */
async function loadHtpasswd(): Promise<LoadedHtpasswd> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < TTL_MS) return cache;

  const client = getCoreClient();
  const name = htpasswdSecretName();
  const namespace = htpasswdSecretNamespace();
  const dataKey = htpasswdSecretKey();

  let secret;
  try {
    // The API's Secret `data` values are base64-encoded; client-node does not
    // decode them, so we decode locally (see readSecretData below).
    secret = await client.readNamespacedSecret({ name, namespace });
  } catch (err) {
    throw new Error(
      `无法读取 htpasswd Secret ${namespace}/${name}(请确认已创建,内含 data 键 "${dataKey}"):${describeError(err)}`,
    );
  }

  const raw = secret.data?.[dataKey];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`htpasswd Secret ${namespace}/${name} 缺少 data 键 "${dataKey}"`);
  }

  const entries = parseHtpasswd(readSecretData(raw));
  cache = { entries, loadedAt: now };
  return cache;
}

/** Decode a Secret data value (base64), falling back to plain text safety. */
function readSecretData(value: string): string {
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    // If base64 decoding produced garbage, prefer the original value.
    return decoded.includes("\uFFFD") ? value : decoded;
  } catch {
    return value;
  }
}

/** Parse `user:hash` lines into a map, ignoring blank lines and comments. */
export function parseHtpasswd(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue; // no username or no separator
    const user = trimmed.slice(0, colon).trim();
    const hash = trimmed.slice(colon + 1).trim();
    if (user && hash) entries.set(user, hash);
  }
  return entries;
}

/**
 * Verify a username/password pair against the htpasswd Secret. Resolves to the
 * authenticated username on success, or null on a mismatch / unknown user.
 * Throws only when the Secret cannot be loaded at all.
 */
export async function verifyCredentials(username: string, password: string): Promise<string | null> {
  const user = username.trim();
  const pass = password ?? "";
  if (!user || pass.length === 0) return null;

  const { entries } = await loadHtpasswd();
  const hash = entries.get(user);
  if (!hash) return null;

  // bcryptjs compareSync supports $2a$/$2b$/$2y$ prefixes. A malformed hash
  // line is treated as a mismatch, never a crash.
  try {
    return compareSync(pass, hash) ? user : null;
  } catch {
    return null;
  }
}

/** Clear the loaded-secret cache (used by tests / admin changes). */
export function resetHtpasswdCache(): void {
  cache = null;
}

function describeError(err: unknown): string {
  const status =
    (err as { statusCode?: number } | null)?.statusCode ?? (err as Error & { statusCode?: number })?.statusCode;
  if (status === 404) return "not found(404)";
  const message = err instanceof Error ? err.message : (err as { message?: string } | null)?.message;
  return message ?? String(err);
}