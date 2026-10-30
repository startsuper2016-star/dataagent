import { createTranslator, isLocale } from "./translate";
import { DEFAULT_LOCALE, type Locale, type TranslateFn } from "./types";

function currentLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const stored = window.localStorage.getItem("data-tasks:locale:v1");
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/**
 * Locale-aware translator for non-hook modules (pure render helpers, label
 * resolvers). Reads the locale the same way LocaleProvider does (localStorage
 * with DEFAULT_LOCALE fallback), so results refresh whenever the host
 * component re-renders after a LanguageToggle switch.
 */
export function localeT(): TranslateFn {
  return createTranslator(currentLocale());
}
