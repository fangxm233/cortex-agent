// input:  localStorage, matchMedia, document root
// output: Theme, accent, and motion resolve/persist/apply helpers
// pos:    Device-local appearance preference utilities
// >>> If I am updated, update my header comment and CORTEX.md <<<

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = Exclude<Theme, 'system'>;
export type AccentHue = number | null;
/** Chroma scale applied to every derived accent step. */
export type AccentIntensity = 'soft' | 'normal' | 'vivid';
/** Animation policy; `system` defers to `prefers-reduced-motion`. */
export type MotionMode = 'system' | 'full' | 'reduced';

export const THEME_STORAGE_KEY = 'cortex.theme';
export const ACCENT_HUE_STORAGE_KEY = 'cortex.accent-hue';
export const ACCENT_INTENSITY_STORAGE_KEY = 'cortex.accent-intensity';
export const MOTION_STORAGE_KEY = 'cortex.motion';
export const DEFAULT_THEME: Theme = 'light';
export const DEFAULT_ACCENT_HUE = 274;
export const DEFAULT_ACCENT_INTENSITY: AccentIntensity = 'normal';
export const DEFAULT_MOTION_MODE: MotionMode = 'system';

const ACCENT_INTENSITIES: readonly AccentIntensity[] = ['soft', 'normal', 'vivid'];
const MOTION_MODES: readonly MotionMode[] = ['system', 'full', 'reduced'];

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

function parseOption<T extends string>(stored: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(stored as T) ? (stored as T) : fallback;
}

function readOption<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    return parseOption(window.localStorage.getItem(key), allowed, fallback);
  } catch {
    return fallback;
  }
}

/** Persists `value`, dropping the entry entirely when it is the default (keeps localStorage clean). */
function storeOption<T extends string>(key: string, value: T, fallback: T): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === fallback) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function parseStoredAccentIntensity(stored: string | null): AccentIntensity {
  return parseOption(stored, ACCENT_INTENSITIES, DEFAULT_ACCENT_INTENSITY);
}

export function readStoredAccentIntensity(): AccentIntensity {
  return readOption(ACCENT_INTENSITY_STORAGE_KEY, ACCENT_INTENSITIES, DEFAULT_ACCENT_INTENSITY);
}

export function storeAccentIntensity(intensity: AccentIntensity): void {
  storeOption(ACCENT_INTENSITY_STORAGE_KEY, intensity, DEFAULT_ACCENT_INTENSITY);
}

export function parseStoredMotionMode(stored: string | null): MotionMode {
  return parseOption(stored, MOTION_MODES, DEFAULT_MOTION_MODE);
}

export function readStoredMotionMode(): MotionMode {
  return readOption(MOTION_STORAGE_KEY, MOTION_MODES, DEFAULT_MOTION_MODE);
}

export function storeMotionMode(mode: MotionMode): void {
  storeOption(MOTION_STORAGE_KEY, mode, DEFAULT_MOTION_MODE);
}

export function watchSystemTheme(onChange: (prefersDark: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const handleChange = (event: MediaQueryListEvent) => onChange(event.matches);
  query.addEventListener('change', handleChange);
  return () => query.removeEventListener('change', handleChange);
}

/** `color(srgb r g b)` / `rgb(r, g, b)` -> `#rrggbb`; anything else yields null. */
function toHexColor(computed: string): string | null {
  const parts = computed.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return null;
  const srgb = /^color/.test(computed);
  const channels = parts.slice(0, 3).map((part) => {
    const value = Number(part);
    return Math.max(0, Math.min(255, Math.round(srgb ? value * 255 : value)));
  });
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// The token resolves through color-mix(), and custom properties are not colour-evaluated by
// getPropertyValue — so the value has to be read back off a real element's `color`.
function syncBrowserThemeColor(): void {
  if (typeof getComputedStyle !== 'function') return;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const probe = document.createElement('span');
  probe.style.cssText = 'display:none;color:var(--browser-theme-color)';
  document.documentElement.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const hex = toHexColor(computed);
  if (hex) meta.setAttribute('content', hex);
}

/** Re-reads the browser chrome colour after a palette change. */
export function refreshBrowserThemeColor(): void {
  if (typeof document === 'undefined') return;
  syncBrowserThemeColor();
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

export function applyAccentIntensity(intensity: AccentIntensity): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (intensity === 'normal') root.removeAttribute('data-accent-intensity');
  else root.setAttribute('data-accent-intensity', intensity);
  syncBrowserThemeColor();
}

/** `system` leaves the attribute off so the `prefers-reduced-motion` media rule governs. */
export function applyMotionMode(mode: MotionMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-motion');
  else root.setAttribute('data-motion', mode);
}
