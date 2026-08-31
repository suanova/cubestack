"use client";

import { Dictionary, MessageKey, dictionaries } from "./dictionaries";
import { Locale, LOCALES, setPlatformLocale, usePlatformLocale } from "./locale";

function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

export interface I18n {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** Look up a localized string; replace {name} placeholders via params. */
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

/** Current platform locale + the dictionary for it, reactive to switches. */
export function useI18n(): I18n {
  const locale = usePlatformLocale();
  const dict: Dictionary = dictionaries[locale];
  return {
    locale,
    setLocale: setPlatformLocale,
    t: (key, params) => interpolate(dict[key], params),
  };
}

export { LOCALES };
export type { Locale, MessageKey };
