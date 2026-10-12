import { dictionaries, type MessageKey } from "@/lib/i18n/dictionaries";

/**
 * What a route answers a rejected request with: a stable code, and the values the
 * sentence built from it needs (`{name}`, `{max}`, `{types}` …). No prose — the
 * sentence lives in the portal's dictionaries, in all three locales, which is
 * the only place a user-facing string can live.
 */
export interface ValidationErrorBody {
  error?: string;
  params?: Record<string, string | number>;
}

/** The key set is locale-independent: zh-CN is the source of truth. */
const KEY_SET = dictionaries["zh-CN"];

/**
 * The sentence for a rejected request, in the user's own language.
 *
 * The codes are the console's own vocabulary (`dev.err.<code>` for the dev
 * environment routes, `inf.err.<code>` for the inference ones), so a route that
 * is newer than this bundle can still send one this build has never heard of. A
 * bare code is a poor sentence but an honest one — it names what was refused,
 * where `HTTP 400` names nothing.
 */
export function validationMessage(
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  body: ValidationErrorBody,
  status: number,
  prefix: "dev" | "inf",
): string {
  const code = body.error;
  if (!code) return `HTTP ${status}`;
  const key = `${prefix}.err.${code}`;
  return key in KEY_SET ? t(key as MessageKey, body.params) : code;
}
