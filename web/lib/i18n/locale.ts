"use client";

// Locale store, a structural mirror of lib/perses/theme.ts: the platform's
// language is driven by localStorage["cubestack-locale"] — falling back to the
// browser's language — stamped onto <html data-locale> and <html lang> by the
// inline bootstrap script in the root layout; the language switcher flips
// data-locale and re-persists. Components read it via useSyncExternalStore so
// they re-render on change.

import { useEffect, useSyncExternalStore } from "react";

export const PLATFORM_LOCALE_STORAGE_KEY = "cubestack-locale";

export const LOCALES = ["zh-CN", "zh-TW", "en"] as const;
export type Locale = (typeof LOCALES)[number];

// Product default when nothing is stored and the browser isn't zh/en.
const DEFAULT_LOCALE: Locale = "zh-CN";

function isLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "zh-TW" || value === "en";
}

// Client snapshot reads the attribute stamped by the inline script before
// hydration, so the first client render already matches the stored locale.
const getLocaleSnapshot = (): Locale => {
  const value = document.documentElement.dataset.locale;
  return isLocale(value) ? value : DEFAULT_LOCALE;
};

// Server snapshot is the product default so SSR and the first client render
// agree (no hydration mismatch); the inline script corrects it before paint.
const getServerSnapshot = (): Locale => DEFAULT_LOCALE;

function subscribeToLocale(onStoreChange: () => void): () => void {
  const html = document.documentElement;
  const observer = new MutationObserver(onStoreChange);
  observer.observe(html, { attributes: true, attributeFilter: ["data-locale"] });
  const onStorage = (event: StorageEvent) => {
    // key === null covers localStorage.clear(); re-read data-locale either way.
    if (event.key === PLATFORM_LOCALE_STORAGE_KEY || event.key === null) {
      onStoreChange();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    observer.disconnect();
    window.removeEventListener("storage", onStorage);
  };
}

function getStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(PLATFORM_LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // localStorage unavailable (private mode etc.); fall through to the browser.
  }
  const nav = (navigator.language ?? "zh-CN").toLowerCase();
  if (nav.startsWith("zh")) {
    return /tw|hk|mo|hant/.test(nav) ? "zh-TW" : "zh-CN";
  }
  if (nav.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

/** Stamp the stored/browser locale onto <html data-locale> + <html lang>. Idempotent. */
export function applyPlatformLocale(): void {
  const locale = getStoredLocale();
  const html = document.documentElement;
  html.dataset.locale = locale;
  html.lang = locale;
}

/** Persist a locale and apply it, matching the language switcher. */
export function setPlatformLocale(locale: Locale): void {
  const html = document.documentElement;
  html.dataset.locale = locale;
  html.lang = locale;
  try {
    localStorage.setItem(PLATFORM_LOCALE_STORAGE_KEY, locale);
  } catch {
    // ignore — the switch still applies for this page
  }
}

/**
 * The current locale as an external store, observed via the <html data-locale>
 * attribute (MutationObserver) and cross-tab storage events.
 */
export function usePlatformLocale(): Locale {
  // Belt and suspenders: the root layout's inline script stamps data-locale
  // before hydration, but re-apply on mount in case it was stripped.
  useEffect(() => {
    applyPlatformLocale();
  }, []);

  return useSyncExternalStore(subscribeToLocale, getLocaleSnapshot, getServerSnapshot);
}
