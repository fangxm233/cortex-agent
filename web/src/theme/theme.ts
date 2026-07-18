// Color theme (light / dark) — a real, user-controlled, persisted choice, mirroring the language
// system (`i18n/lang.ts`). The theme is applied by toggling `data-theme="dark"` on the document
// root; every color in the app is a CSS variable that switches on that selector (see index.css and
// the `var(--…)` token wiring in tailwind.config.ts + mobile/ui/kit.tsx). Dark palette is a strict
// 1:1 encoding of design/ref/scheme-dark.dc.html (per-level remap, not an inversion).

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'cortex.theme';
export const DEFAULT_THEME: Theme = 'light';

/** The persisted theme choice, else the OS `prefers-color-scheme`, else the default. Pure over its
 *  inputs so it is testable without a DOM. */
export function resolveInitialTheme(stored: string | null, prefersDark?: boolean): Theme {
  if (stored === 'light' || stored === 'dark') return stored;
  if (prefersDark) return 'dark';
  return DEFAULT_THEME;
}

function prefersDarkNow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    /* private mode */
  }
  return resolveInitialTheme(stored, prefersDarkNow());
}

export function storeTheme(theme: Theme): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

/** Reflect the theme onto the document root so the CSS-variable cascade (index.css) applies. Light
 *  is the default cascade (no attribute); dark sets `data-theme="dark"`. Also stamps `color-scheme`
 *  so native form controls / scrollbars match. Safe no-op under SSR. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
  root.style.colorScheme = theme;
}
