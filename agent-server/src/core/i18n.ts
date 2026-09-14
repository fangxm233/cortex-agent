// input:  en/zh locale tables (core/locales), process.env.CORTEX_LANG (initial locale only)
// output: t(key, params) / setLocale / getLocale / normalizeLocale + Locale type
// pos:    L0 zero-dependency i18n layer. MUST NOT import domain/* — the active locale is set
//         by the wiring layer (entry/app.ts) via setLocale(); this module never reads config.

import { en, type MessageKey } from './locales/en.js';
import { zh } from './locales/zh.js';

export type Locale = 'en' | 'zh';

const LOCALES: Record<Locale, Record<string, string>> = { en, zh };

/** Coerce an arbitrary string (env/config/user input) to a supported Locale, defaulting to 'en'. */
export function normalizeLocale(raw: string | undefined | null): Locale {
  return raw === 'zh' ? 'zh' : 'en';
}

/**
 * Best-effort detection of the operator's system language from POSIX locale env vars.
 * Precedence follows POSIX: LC_ALL > LC_MESSAGES > LANG > LANGUAGE. A value whose language
 * tag starts with "zh" (zh_CN, zh_TW, zh-Hans, ...) maps to 'zh'; everything else (incl. unset,
 * "C", "POSIX") falls back to 'en'. Used by `cortex init` to pre-select the language option.
 */
export function detectSystemLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE || '';
  return raw.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

// Initial locale comes only from the environment (escape hatch / boot default). The wiring layer
// overrides it with the persisted preference via setLocale() right after config load.
let currentLocale: Locale = normalizeLocale(process.env.CORTEX_LANG);

export function setLocale(loc: Locale): void {
  currentLocale = normalizeLocale(loc);
}

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Translate a message key in the active locale. Resolution order:
 *   active-locale table → en table (fallback) → the raw key (last resort).
 * `${param}` placeholders are substituted from `params`.
 */
export function t(key: MessageKey | string, params?: Record<string, string | number>): string {
  const table = LOCALES[currentLocale] ?? en;
  let str = table[key] ?? (en as Record<string, string>)[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.split('${' + k + '}').join(String(v));
    }
  }
  return str;
}
