import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PLATFORM_THEME_STORAGE_KEY,
  applyPlatformTheme,
  applyStoredTheme,
  getStoredTheme,
  togglePlatformTheme,
} from "./theme-storage";

function mockMatchMedia(dark: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === "(prefers-color-scheme: dark)" && dark,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  }));
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  mockMatchMedia(false);
});

describe("getStoredTheme", () => {
  it("follows the OS preference when nothing is stored", () => {
    mockMatchMedia(false);
    expect(getStoredTheme()).toBe("light");
    mockMatchMedia(true);
    expect(getStoredTheme()).toBe("dark");
  });

  it("prefers a stored theme over the OS preference", () => {
    localStorage.setItem(PLATFORM_THEME_STORAGE_KEY, "dark");
    mockMatchMedia(false); // light OS
    expect(getStoredTheme()).toBe("dark");
  });

  it("ignores an invalid stored value and falls back to the OS", () => {
    localStorage.setItem(PLATFORM_THEME_STORAGE_KEY, "neon");
    mockMatchMedia(false);
    expect(getStoredTheme()).toBe("light");
  });
});

describe("applyPlatformTheme", () => {
  it("stamps data-theme from the stored theme", () => {
    localStorage.setItem(PLATFORM_THEME_STORAGE_KEY, "dark");
    applyPlatformTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("stamps data-theme from the OS when nothing is stored", () => {
    mockMatchMedia(true);
    applyPlatformTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("keeps a theme the document already carries", () => {
    // This is the first paint of `?theme=dark` with nothing stored: the root
    // layout's inline script stamps "dark" before hydration, and re-applying the
    // stored/OS theme here is what painted the override away again (light at
    // ~3ms, measured on cs7).
    localStorage.setItem(PLATFORM_THEME_STORAGE_KEY, "light");
    mockMatchMedia(false);
    document.documentElement.dataset.theme = "dark";

    applyPlatformTheme();

    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("replaces a stamp it cannot read", () => {
    document.documentElement.dataset.theme = "neon";
    localStorage.setItem(PLATFORM_THEME_STORAGE_KEY, "dark");

    applyPlatformTheme();

    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("applyStoredTheme", () => {
  it("stamps the stored theme over the document's own", () => {
    // The cross-tab path: another tab has just picked a theme, and its choice is
    // newer than this document's stamp.
    document.documentElement.dataset.theme = "dark";
    localStorage.setItem(PLATFORM_THEME_STORAGE_KEY, "light");

    applyStoredTheme();

    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

describe("togglePlatformTheme", () => {
  it("flips data-theme and persists it", () => {
    applyPlatformTheme(); // no stored theme + light OS → starts light
    togglePlatformTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(PLATFORM_THEME_STORAGE_KEY)).toBe("dark");
  });
});
