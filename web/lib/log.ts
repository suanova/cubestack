// Levelled, dependency-free logging for the portal.
//
// Everything the portal does that can fail silently (kubeconfig resolution,
// every custom-object call, gateway discovery, htpasswd reads) goes through
// here, so a deployment with CUBESTACK_LOG_LEVEL=debug answers "why is the page
// empty?" from `kubectl logs` alone.
//
// Levels: error < warn < info < debug (default info). info logs one line per
// API request plus warnings; debug adds every cluster/gateway call with its
// scope, arguments and outcome. Values are printed as key=value pairs; never
// log credentials (apiKeys, tokens, htpasswd content, SESSION_SECRET).

export type LogLevel = "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function configuredLevel(): LogLevel {
  const raw = (process.env.CUBESTACK_LOG_LEVEL ?? "").trim().toLowerCase();
  return raw === "error" || raw === "warn" || raw === "info" || raw === "debug" ? raw : "info";
}

/** Whether a level is emitted (exported for tests). */
export function levelEnabled(level: LogLevel, configured: string | undefined = process.env.CUBESTACK_LOG_LEVEL): boolean {
  const raw = (configured ?? "").trim().toLowerCase();
  const current: LogLevel = raw === "error" || raw === "warn" || raw === "info" || raw === "debug" ? raw : "info";
  return ORDER[level] <= ORDER[current];
}

/** Render a value for a log line: short, single-line, never multiline dumps. */
function fmt(value: unknown): string {
  if (value === undefined || value === null) return "-";
  if (value instanceof Error) return JSON.stringify(`${value.name}: ${value.message}`.slice(0, 300));
  if (typeof value === "string") return /[\s"=]/.test(value) ? JSON.stringify(value.slice(0, 300)) : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value).slice(0, 300);
  } catch {
    return String(value);
  }
}

export function log(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void {
  if (!levelEnabled(level)) return;
  const parts = Object.entries(fields ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${fmt(v)}`);
  const line = `[${level}] ${scope}: ${message}${parts.length ? " " + parts.join(" ") : ""}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = (scope: string) => ({
  error: (message: string, fields?: Record<string, unknown>) => log("error", scope, message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => log("warn", scope, message, fields),
  info: (message: string, fields?: Record<string, unknown>) => log("info", scope, message, fields),
  debug: (message: string, fields?: Record<string, unknown>) => log("debug", scope, message, fields),
});

/** The effective level, for the startup line and for diagnostics endpoints. */
export function currentLevel(): LogLevel {
  return configuredLevel();
}
