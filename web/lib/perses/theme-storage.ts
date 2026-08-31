// Theme persistence, split from lib/perses/theme.ts so the pure DOM/storage
// functions can be unit-tested without importing the heavy @perses-dev stack.
// Behavior mirrors the static prototype pages: localStorage["cubestack-theme"]
// → prefers-color-scheme fallback, stamped onto <html data-theme>.

import type { PaletteMode } from "@mui/material";

export const PLATFORM_THEME_STORAGE_KEY = "cubestack-theme";

function isTheme(value: unknown): value is PaletteMode {
  return value === "dark" || value === "light";
}

/** The stored theme, falling back to the OS preference (or "light"). */
export function getStoredTheme(): PaletteMode {
  try {
    const stored = localStorage.getItem(PLATFORM_THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // localStorage unavailable (private mode etc.); fall through to the OS.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Stamp the stored/OS theme onto <html data-theme>. Idempotent. */
export function applyPlatformTheme(): void {
  document.documentElement.dataset.theme = getStoredTheme();
}

/** Flip the theme, matching the toggle on the static prototype pages. */
export function togglePlatformTheme(): void {
  const next: PaletteMode =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(PLATFORM_THEME_STORAGE_KEY, next);
  } catch {
    // ignore — the toggle still works for this page
  }
}
