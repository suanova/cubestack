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

/** Uptime from seconds: "5m 3s" under an hour, "3h 20m" under a day, "4d 6h"
 *  beyond — two units each, and each one naming the quantity it computed.
 *
 *  The reference stops at minutes and prints "6174m 59s" for a four-day
 *  instance: correct, and unreadable. The coarser tiers are ours, and the first
 *  version of them divided MINUTES by 60 and labelled the result "d" — so every
 *  uptime over an hour read 24x longer than it was (a four-day-old instance
 *  showed "102d"). */
export function fmtSeconds(totalSeconds?: number): string {
  if (totalSeconds == null) return "-";
  // Under a minute is just seconds: "0m 26s" is what a countdown about to expire
  // reads as, and that is exactly when someone is watching it.
  if (totalSeconds < 60) return totalSeconds + "s";
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return minutes + "m " + (totalSeconds % 60) + "s";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h " + (minutes % 60) + "m";
  return Math.floor(hours / 24) + "d " + (hours % 24) + "h";
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
