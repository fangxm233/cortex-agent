import { en, zh, type Vocab } from './vocab';

export type Lang = 'en' | 'zh';

// Mobile / desktop boundary. Matches Tailwind's default `md` breakpoint:
// width <= 767 is mobile (→ zh); >= 768 is desktop (→ en).
export const MOBILE_MAX_WIDTH = 767;

export function deriveLang(viewportWidth: number): Lang {
  return viewportWidth <= MOBILE_MAX_WIDTH ? 'zh' : 'en';
}

export function pickVocab(lang: Lang): Vocab {
  return lang === 'zh' ? zh : en;
}

// ── Language selection (user toggle, persisted — no longer viewport-driven) ──
export const LANG_STORAGE_KEY = 'cortex.lang';
export const DEFAULT_LANG: Lang = 'en';

/** The persisted language choice, else the browser preference, else the default. Pure over its
 *  inputs so it is testable without a DOM. */
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
