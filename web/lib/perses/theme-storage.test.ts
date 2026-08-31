import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PLATFORM_THEME_STORAGE_KEY,
  applyPlatformTheme,
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
});

describe("togglePlatformTheme", () => {
  it("flips data-theme and persists it", () => {
    applyPlatformTheme(); // no stored theme + light OS → starts light
    togglePlatformTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(PLATFORM_THEME_STORAGE_KEY)).toBe("dark");
  });
});
