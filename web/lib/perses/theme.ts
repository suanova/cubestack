"use client";

// Platform theme, aligned with the static prototype pages in public/
// (overview.html and siblings). Dark/light there is driven by
// localStorage["cubestack-theme"] — falling back to prefers-color-scheme —
// stamped onto <html data-theme> by an inline head script; the toggle flips
// data-theme and re-persists. We mirror that mechanism here so the dashboard
// pages share the platform's saved theme and stay in sync with its toggle.
//
// The dark surface/border/muted values are the color-mix() expressions from
// overview.html approximated to fixed sRGB values: ECharts paints to a canvas,
// so it needs concrete colors, not CSS color functions.

import { PaletteMode, Theme, createTheme } from "@mui/material";
import {
  PersesChartsTheme,
  generateChartsTheme,
  getTheme,
} from "@perses-dev/components";
import { useEffect, useSyncExternalStore } from "react";

import {
  applyPlatformTheme,
  PLATFORM_THEME_STORAGE_KEY,
  togglePlatformTheme,
} from "./theme-storage";

// Re-export so existing consumers (ThemeToggle, PersesProvider) keep importing
// from this module.
export { applyPlatformTheme, togglePlatformTheme, PLATFORM_THEME_STORAGE_KEY };

export const PLATFORM_FONT_FAMILY =
  'Inter, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif';

export const PLATFORM_RADIUS = 8;

interface PlatformPalette {
  accent: string;
  bg: string;
  surface: string;
  fg: string;
  muted: string;
  border: string;
}

export const platformPalette: Record<PaletteMode, PlatformPalette> = {
  light: {
    accent: "#1677ff",
    bg: "#ffffff",
    surface: "#f7f8fa",
    fg: "#111111",
    muted: "#6b7280",
    border: "#d9dee7",
  },
  dark: {
    accent: "#1677ff",
    bg: "#111111",
    surface: "#1f1f1f",
    fg: "#ffffff",
    muted: "#9ca3af",
    border: "#34373c",
  },
};

// ECharts categorical palette, led by the platform accent and the hues
// overview.html derives from it (cyan / violet / warn / ok / danger).
const PLATFORM_CHART_COLORS = [
  "#1677ff",
  "#00b3a4",
  "#8b5cf6",
  "#f59e0b",
  "#4ade80",
  "#f43f5e",
  "#94a3b8",
];

/**
 * MUI theme for the dashboards: perses's own theme (with its component
 * overrides) merged with the platform tokens. createTheme deep-merges, so the
 * perses component overrides are kept while palette/typography/shape are ours.
 */
export function buildPlatformMuiTheme(mode: PaletteMode): Theme {
  const p = platformPalette[mode];
  return createTheme(getTheme(mode), {
    palette: {
      mode,
      primary: {
        main: p.accent,
        light: mode === "dark" ? "#5a9bff" : "#4d8efc",
        dark: "#0f5cc0",
        contrastText: "#ffffff",
      },
      // Cards on the platform are the page background separated by a border,
      // so paper (Cards, menus) shares the page background here too.
      background: { default: p.bg, paper: p.bg },
      text: { primary: p.fg, secondary: p.muted },
      divider: p.border,
    },
    typography: { fontFamily: PLATFORM_FONT_FAMILY },
    shape: { borderRadius: PLATFORM_RADIUS },
  });
}

/**
 * The bits of the ECharts theme that don't follow from the MUI palette:
 * axis/split-line colors use the platform border, and series colors are the
 * platform palette. (categoryAxis/timeAxis/valueAxis are ECharts theme keys,
 * not EChartsOption keys, hence the cast.)
 */
export function platformChartsThemeOverride(
  mode: PaletteMode,
): Partial<PersesChartsTheme> {
  const p = platformPalette[mode];
  const axis = {
    axisLine: { lineStyle: { color: p.border } },
    splitLine: { lineStyle: { color: p.border } },
  };
  return {
    echartsTheme: {
      color: PLATFORM_CHART_COLORS,
      categoryAxis: axis,
      timeAxis: axis,
      valueAxis: { splitLine: { lineStyle: { color: p.border } } },
    },
    sparkline: { color: p.accent },
  } as unknown as Partial<PersesChartsTheme>;
}

/**
 * ECharts theme derived from the platform MUI theme plus the platform-specific
 * overrides above. Convenience used by the provider chain.
 */
export function buildPlatformChartsTheme(mode: PaletteMode): PersesChartsTheme {
  return generateChartsTheme(
    buildPlatformMuiTheme(mode),
    platformChartsThemeOverride(mode),
  );
}

const getThemeSnapshot = (): PaletteMode =>
  document.documentElement.dataset.theme === "dark" ? "dark" : "light";

// Server snapshot is always "light" so SSR and the first client render agree
// (no hydration mismatch); the head script stamps data-theme before hydration,
// so the client's first read is already the stored theme.
const getServerSnapshot = (): PaletteMode => "light";

function subscribeToPlatformTheme(onStoreChange: () => void): () => void {
  const html = document.documentElement;
  const observer = new MutationObserver(onStoreChange);
  observer.observe(html, { attributes: true, attributeFilter: ["data-theme"] });
  const onStorage = (event: StorageEvent) => {
    // key === null covers localStorage.clear(). Apply the persisted theme to
    // this document before notifying, so getThemeSnapshot re-reads the new
    // value instead of this tab's stale data-theme.
    if (event.key === PLATFORM_THEME_STORAGE_KEY || event.key === null) {
      applyPlatformTheme();
      onStoreChange();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    observer.disconnect();
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * The current platform theme as an external store, observed via the
 * <html data-theme> attribute (MutationObserver) and cross-tab storage events.
 */
export function usePlatformTheme(): PaletteMode {
  // Belt and suspenders: the root layout's inline script stamps data-theme
  // before hydration, but re-apply on mount in case it was stripped.
  useEffect(() => {
    applyPlatformTheme();
  }, []);

  return useSyncExternalStore(
    subscribeToPlatformTheme,
    getThemeSnapshot,
    getServerSnapshot,
  );
}
