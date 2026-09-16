// input:  bilingual vocab tables, cached language choice
// output: Lang type, vocab picker, and the local-storage CACHE of the server language
// pos:    Language resolution helpers. The language itself is owned by the server
//         (config/preferences.json); see LangProvider.
import { en, zh, type Vocab } from './vocab';

export type Lang = 'en' | 'zh';

// Browser layout boundary used by useMobileLayout; matches Tailwind's default `md` breakpoint.
// Language is independent of the current layout.
export const MOBILE_MAX_WIDTH = 767;

/** Legacy width-to-language helper; not used for the active language or layout. */
export function deriveLang(viewportWidth: number): Lang {
  return viewportWidth <= MOBILE_MAX_WIDTH ? 'zh' : 'en';
}

export function pickVocab(lang: Lang): Vocab {
  return lang === 'zh' ? zh : en;
}

// ── Language selection ───────────────────────────────────────────────────────
// The language is ONE server-side setting (config/preferences.json → `lang`), because it decides
// both this SPA's vocabulary AND the language Cortex speaks in the conversation — auto-compaction
// notices, `!` command replies, status lines all render through the server's `t()`. Two independent
// knobs is how you end up with an English UI printing "上下文已自动压缩。".
//
// Local storage is therefore a CACHE, not the source of truth: it only supplies the first paint
// (and keeps the toggle usable while the server is unreachable — the connect/login flow renders
// before any authenticated query can succeed). `config.get` overwrites it as soon as it lands.
export const LANG_STORAGE_KEY = 'cortex.lang';
export const DEFAULT_LANG: Lang = 'en';

/** The cached language, else the browser preference, else the default. Pure over its inputs so it
 *  is testable without a DOM. Only ever a first-paint guess — the server's value wins. */
export function resolveInitialLang(stored: string | null, navigatorLang?: string): Lang {
  if (stored === 'en' || stored === 'zh') return stored;
  if (navigatorLang && navigatorLang.toLowerCase().startsWith('zh')) return 'zh';
  return DEFAULT_LANG;
}

export function readStoredLang(): Lang {
  if (typeof window === 'undefined') return DEFAULT_LANG;
  let stored: string | null = null;
  try { stored = window.localStorage.getItem(LANG_STORAGE_KEY); } catch { /* private mode */ }
  return resolveInitialLang(stored, typeof navigator !== 'undefined' ? navigator.language : undefined);
}

export function storeLang(lang: Lang): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(LANG_STORAGE_KEY, lang); } catch { /* ignore */ }
}
