// Client-side formatting helpers for the 智能助手 panes (ported from the
// reference web/src/utils/format.ts). Kept in components/ because they touch
// the DOM (downloadText); the cron helpers live in lib/cubepilot/cron.ts.

/** 2026-08-06T06:00:00Z → "06:00" (same day) or "08-06 06:00". */
export function fmtTime(v?: string): string {
  if (!v) return "-";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "-";
  const pad = (n: number) => (n < 10 ? "0" + n : "" + n);
  const sameDay = d.toDateString() === new Date().toDateString();
  return (
    (sameDay ? "" : pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " ") +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

/** Duration between two timestamps as "3m 20s" / "42s". */
export function fmtDuration(a?: string, b?: string): string {
  if (!a || !b) return "-";
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (isNaN(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  return Math.floor(s / 60) + "m " + (s % 60) + "s";
}

/** "73m 5s" style uptime from seconds. */
export function fmtUptime(totalSeconds?: number): string {
  if (totalSeconds == null) return "-";
  const m = Math.floor(totalSeconds / 60);
  if (m >= 60) return Math.floor(m / 60) + "d " + (m % 60) + "m";
  return m + "m " + (totalSeconds % 60) + "s";
}

/** Trigger a client-side download of a text file (report export). */
export function downloadText(name: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
