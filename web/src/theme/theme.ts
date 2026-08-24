// input:  localStorage, matchMedia, document root
// output: Theme and accent resolve, persist, apply, and watch helpers
// pos:    Device-local appearance preference utilities
// >>> If I am updated, update my header comment and CORTEX.md <<<

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = Exclude<Theme, 'system'>;
export type AccentHue = number | null;

export const THEME_STORAGE_KEY = 'cortex.theme';
export const ACCENT_HUE_STORAGE_KEY = 'cortex.accent-hue';
export const DEFAULT_THEME: Theme = 'light';
export const DEFAULT_ACCENT_HUE = 274;

/** The persisted theme choice, else the OS `prefers-color-scheme`, else the default. Pure over its
 *  inputs so it is testable without a DOM. */
export function resolveInitialTheme(stored: string | null, prefersDark?: boolean): Theme {
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  if (prefersDark) return 'dark';
  return DEFAULT_THEME;
}

export function resolveEffectiveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return theme;
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

export function parseStoredAccentHue(stored: string | null): AccentHue {
  if (stored === null || stored.trim() === '') return null;
  const hue = Number(stored);
  if (!Number.isInteger(hue) || hue < 0 || hue > 359) return null;
  return hue;
}

export function readStoredAccentHue(): AccentHue {
  if (typeof window === 'undefined') return null;
  try {
    return parseStoredAccentHue(window.localStorage.getItem(ACCENT_HUE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function storeAccentHue(hue: AccentHue): void {
  if (typeof window === 'undefined') return;
  try {
    if (hue === null) window.localStorage.removeItem(ACCENT_HUE_STORAGE_KEY);
    else window.localStorage.setItem(ACCENT_HUE_STORAGE_KEY, String(hue));
  } catch {
    /* ignore */
  }
}

export function watchSystemTheme(onChange: (prefersDark: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const handleChange = (event: MediaQueryListEvent) => onChange(event.matches);
  query.addEventListener('change', handleChange);
  return () => query.removeEventListener('change', handleChange);
}

function syncBrowserThemeColor(): void {
  if (typeof getComputedStyle !== 'function') return;
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue('--browser-theme-color')
    .trim();
  if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}

/** Applies the preference through the existing light/dark CSS-variable cascade. */
export function applyTheme(theme: Theme, prefersDark = prefersDarkNow()): void {
  if (typeof document === 'undefined') return;
  const effectiveTheme = resolveEffectiveTheme(theme, prefersDark);
  const root = document.documentElement;
  if (effectiveTheme === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
  root.style.colorScheme = effectiveTheme;
  syncBrowserThemeColor();
}

export function applyAccentHue(hue: AccentHue): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (hue === null) {
    root.removeAttribute('data-accent');
    root.style.removeProperty('--accent-hue');
  } else {
    root.setAttribute('data-accent', 'custom');
    root.style.setProperty('--accent-hue', String(hue));
  }
  syncBrowserThemeColor();
}
