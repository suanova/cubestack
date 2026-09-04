// Auth configuration, read from the environment. Everything is derived here
// so the rest of the auth code (and its tests) can import plain values.

/** Name of the Kubernetes Secret holding the htpasswd file. */
export function htpasswdSecretName(): string {
  return process.env.HTPASSWD_SECRET_NAME ?? "cubestack-htpasswd";
}

/** Namespace of the Kubernetes Secret holding the htpasswd file. */
export function htpasswdSecretNamespace(): string {
  return process.env.HTPASSWD_SECRET_NAMESPACE ?? "cubestack-system";
}

/** Data key inside the htpasswd Secret that holds the `user:bcrypt` lines. */
export function htpasswdSecretKey(): string {
  return process.env.HTPASSWD_SECRET_KEY ?? "htpasswd";
}

/** Name of the signed session cookie. */
export function sessionCookieName(): string {
  return process.env.SESSION_COOKIE_NAME ?? "cubestack-session";
}

/** Session lifetime in milliseconds (default 24 h). */
export function sessionTtlMs(): number {
  const raw = process.env.SESSION_TTL_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24 * 60 * 60 * 1000;
}

/**
 * The HMAC secret that signs session cookies.
 *
 * Prefer setting SESSION_SECRET explicitly so sessions survive restarts. When
 * absent we fall back to a per-process random key: every restart invalidates
 * existing sessions, but the portal keeps working in dev/e2e without config.
 * In production the fallback is rejected outright — two replicas (or a rolling
 * restart) would otherwise hold different keys and bounce every user to the
 * login page, so we fail fast instead.
 *
 * Always returns a Uint8Array (jose requires an array/CryptoKey source for
 * HMAC); the env value is UTF-8 encoded.
 */
export function sessionSecret(): { key: Uint8Array; ephemeral: boolean } {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv) return { key: new TextEncoder().encode(fromEnv), ephemeral: false };
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET must be set when NODE_ENV=production (set one stable value on every web process)",
    );
  }
  return { key: ephemeralSecret(), ephemeral: true };
}

let _ephemeral: Uint8Array | null = null;
function ephemeralSecret(): Uint8Array {
  if (!_ephemeral) {
    _ephemeral = new Uint8Array(32);
    if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
      globalThis.crypto.getRandomValues(_ephemeral);
    } else {
      // Non-browser fallback (Node without global crypto); 32 bytes of noise.
      for (let i = 0; i < 32; i++) _ephemeral[i] = Math.floor(Math.random() * 256);
    }
  }
  return _ephemeral;
}

/** Whether the signed-cookie Set-Cookie should carry the Secure flag. */
export function secureCookies(): boolean {
  return process.env.NODE_ENV === "production";
}