// Cron helpers for the 自动化任务 tab: validation, human descriptions and
// next-run computation for 5-field expressions.
//
// Ported from the reference implementation (cubepilot web/src/utils/cron.ts),
// which validates against the operator's hand-written grammar: per field only
// "*", "*/n", plain numbers and comma-separated lists of those (no ranges, no
// names, no 6-field seconds). Schedules are evaluated in UTC (reference issue
// #95), so every human label carries a (UTC) suffix.
//
// The reference describes expressions with the cronstrue package; to keep this
// portal dependency-free, describe() covers the common shapes and degrades to
// the raw expression otherwise.

export interface CronDescription {
  /** Human text when the expression parses; null when empty or invalid. */
  text: string | null;
  /** Hint when the expression is non-empty but not parseable. */
  error: string | null;
}

// Field bounds in standard 5-field order: minute hour day-of-month month
// day-of-week. Day-of-week accepts 0 and 7 (both Sunday).
const FIELD_BOUNDS: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function tokenOk(token: string, min: number, max: number): boolean {
  if (token === "*") return true;
  const digits = /^\d+$/;
  if (token.startsWith("*/")) {
    const step = token.slice(2);
    return digits.test(step) && Number(step) >= 1;
  }
  if (!digits.test(token)) return false;
  const n = Number(token);
  return n >= min && n <= max;
}

function fieldOk(spec: string, min: number, max: number): boolean {
  if (!spec) return false;
  return spec
    .split(",")
    .every((p) => {
      const t = p.trim();
      return t !== "" && tokenOk(t, min, max);
    });
}

/** Whether expr matches the backend 5-field grammar. */
export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== FIELD_BOUNDS.length) return false;
  return FIELD_BOUNDS.every(([min, max], i) => fieldOk(fields[i], min, max));
}

/**
 * Validate and describe. Empty input is a legal "manual-only" schedule.
 * `text` is a Chinese clause for the common shapes; otherwise the raw
 * expression is returned so the dialog never blanks out.
 */
export function cronDescription(expr: string): CronDescription {
  const e = (expr ?? "").trim();
  if (!e) return { text: null, error: null };
  if (!isValidCron(e)) {
    return {
      text: null,
      error: "无效的 Cron 表达式(5 段:分 时 日 月 周;仅支持数字、*/步长、逗号列表,如 0 2 * * *)",
    };
  }
  const [minF, hourF, domF, monF, dowF] = e.split(/\s+/);
  const pad = (n: number) => (n < 10 ? "0" + n : String(n));
  const at = (hm: string) => `${hm.slice(0, 2)}:${hm.slice(2)}`;
  const everyN = (field: string, unit: string): string | null => {
    if (!field.startsWith("*/")) return null;
    return `每 ${field.slice(2)} ${unit}`;
  };
  const plain = (field: string): number | null =>
    field !== "*" && /^\d+$/.test(field) ? Number(field) : null;

  // Common shapes, most specific first.
  const minute = plain(minF);
  const hour = plain(hourF);
  const domNum = plain(domF);
  const dowNum = plain(dowF);
  let text: string;
  if (minute !== null && hour !== null && domNum === null && dowNum === null && monF === "*") {
    text = `每天 ${at(pad(hour) + pad(minute))}`;
  } else if (
    minute !== null &&
    hour !== null &&
    domNum !== null &&
    dowNum === null &&
    monF !== "*"
  ) {
    text = `${monF} 月 ${domF} 日 ${at(pad(hour) + pad(minute))}`;
  } else if (minute !== null && hour !== null && dowNum !== null && domNum === null && monF === "*") {
    const wd = WEEKDAYS[dowNum === 7 ? 0 : dowNum] ?? String(dowNum);
    text = `每周${wd} ${at(pad(hour) + pad(minute))}`;
  } else if (minute !== null && hour === null && domNum === null && dowNum === null && monF === "*") {
    text = `每小时第 ${minute} 分`;
  } else {
    const step = everyN(minF, "分钟");
    text = step ? step : e;
  }
  return { text, error: null };
}

/** Expand one field into the set of matching values (0-59 minute scan space). */
function fieldValues(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const t = part.trim();
    if (t === "*") {
      for (let i = min; i <= max; i++) out.add(i);
    } else if (t.startsWith("*/")) {
      const step = Math.max(1, Number(t.slice(2)) || 1);
      for (let i = min; i <= max; i += step) out.add(i);
    } else if (/^\d+$/.test(t)) {
      const n = Number(t);
      if (n >= min && n <= max) out.add(n);
    }
  }
  return out;
}

/**
 * Next occurrence of a valid 5-field cron expression after `from` (UTC).
 * Scans minute-by-minute, bounded at 366 days; null when no match (e.g.
 * Feb 30). Invalid expressions return null.
 */
export function nextCronRun(expr: string, from: Date): Date | null {
  if (!isValidCron(expr)) return null;
  const [m, h, dom, mon, dow] = expr.trim().split(/\s+/);
  const minutes = fieldValues(m, 0, 59);
  const hours = fieldValues(h, 0, 23);
  const doms = fieldValues(dom, 1, 31);
  const months = fieldValues(mon, 1, 12);
  const dows = fieldValues(dow, 0, 7);
  if (!dows.has(0) || !dows.has(7)) {
    // Normalize: the grammar treats 0 and 7 as the same Sunday.
    if (dows.has(7) && !dows.has(0)) dows.add(0);
    if (dows.has(0) && !dows.has(7)) dows.add(7);
  }

  // Start at the next whole minute.
  const t = new Date(from);
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = from.getTime() + 366 * 24 * 3600 * 1000;

  while (t.getTime() < limit) {
    if (!months.has(t.getUTCMonth() + 1)) {
      // Skip to the 1st of the next month.
      t.setUTCDate(1);
      t.setUTCHours(0, 0, 0, 0);
      t.setUTCMonth(t.getUTCMonth() + 1);
      continue;
    }
    const domMatch = doms.has(t.getUTCDate());
    const dowMatch = dows.has(t.getUTCDay());
    // Standard cron OR-semantics when both day fields are restricted.
    const domRestricted = dom !== "*";
    const dowRestricted = dow !== "*";
    const dayOk = domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
    if (!dayOk) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!hours.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!minutes.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1);
      continue;
    }
    return t;
  }
  return null;
}
