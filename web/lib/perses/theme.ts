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
  applyStoredTheme,
  PLATFORM_THEME_STORAGE_KEY,
  togglePlatformTheme,
} from "./theme-storage";

// Re-export so existing consumers (ThemeToggle, PersesProvider) keep importing
// from this module.
export { applyPlatformTheme, applyStoredTheme, togglePlatformTheme, PLATFORM_THEME_STORAGE_KEY };

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

// ECharts categorical palette. The hues follow ECharts' own stacked-area
// example (mint / cyan / blue / magenta / amber), which is what gives that
// palette its bright, high-chroma look. Each mode gets its own lightness:
// dark mode can take the near-neon tints because they sit on near-black,
// while light mode needs the same hues deepened enough to hold contrast on
// white. Slate and violet round the list out for series beyond five.
const PLATFORM_CHART_COLORS: Record<PaletteMode, string[]> = {
  light: [
    "#2b7fff",
    "#12b981",
    "#00a6c8",
    "#f59e0b",
    "#e6399b",
    "#7c5cff",
    "#7c8ca3",
  ],
  dark: [
    "#37a2ff",
    "#80ffa5",
    "#00ddff",
    "#ffbf00",
    "#ff3d9a",
    "#b388ff",
    "#9fb3c8",
  ],
};

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
 * axis/split-line colors use the platform border, series colors are the
 * platform palette, and line/bar series get a slightly refined default look.
 * These act as defaults — any option a panel's spec sets explicitly still
 * wins. (categoryAxis/timeAxis/valueAxis are ECharts theme keys, not
 * EChartsOption keys, hence the cast.)
 */
export function platformChartsThemeOverride(
  mode: PaletteMode,
): Partial<PersesChartsTheme> {
  const p = platformPalette[mode];
  // Subtle splitline / axis grid; hidden ticks keep the canvas clean.
  const axis = {
    axisLine: { lineStyle: { color: p.border } },
    axisTick: { show: false },
    axisLabel: { color: p.muted },
    splitLine: { lineStyle: { color: p.border, opacity: 0.5, type: "dashed" as const } },
  };
  return {
    echartsTheme: {
      color: PLATFORM_CHART_COLORS[mode],
      textStyle: { color: p.fg, fontFamily: PLATFORM_FONT_FAMILY },
      // Legend follows the grid text color instead of echarts' dark default.
      legend: {
        textStyle: { color: p.muted, fontSize: 11 },
        pageTextStyle: { color: p.muted },
      },
      grid: { top: 20, right: 16, bottom: 0, left: 8, containLabel: true },
      timeAxis: axis,
      categoryAxis: axis,
      valueAxis: { splitLine: { lineStyle: { color: p.border, opacity: 0.35 } } },
      // Defaults for time-series panels (lines, area, bars). Panels reading
      // the theme pick these up; a series that sets its own option wins over
      // them. Wider rounded bars read better than hairline slivers.
      line: {
        showSymbol: true,
        symbol: "circle" as const,
        symbolSize: 4,
        lineStyle: { width: 2 },
        smooth: false,
        emphasis: { lineStyle: { width: 2.5 } },
      },
      bar: {
        barMaxWidth: 28,
        itemStyle: { borderRadius: [3, 3, 0, 0] },
      },
      tooltip: {
        textStyle: { color: p.fg },
        borderColor: p.border,
        backgroundColor: mode === "dark" ? "rgba(31,47,47,0.95)" : "rgba(255,255,255,0.96)",
      },
    },
    sparkline: { color: p.accent, width: 2 },
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
    // value instead of this tab's stale data-theme. The stored value wins here
    // even over a `?theme=` stamp: this tab's override belongs to this tab's URL,
    // and the other tab has just chosen something else.
    if (event.key === PLATFORM_THEME_STORAGE_KEY || event.key === null) {
      applyStoredTheme();
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
  // before hydration, but re-apply on mount in case it was stripped. It is
  // re-applied only where the document carries no theme: the stamp that is
  // already painted may be a `?theme=` override, which this module has no other
  // way to learn about (it was never written to localStorage), and deriving the
  // theme from storage instead is what made the override invisible.
  useEffect(() => {
    applyPlatformTheme();
  }, []);

  return useSyncExternalStore(
    subscribeToPlatformTheme,
    getThemeSnapshot,
    getServerSnapshot,
  );
}
