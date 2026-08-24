// input:  React context, persisted appearance helpers, system scheme
// output: ThemeProvider and hooks for theme and accent preferences
// pos:    React owner for global device-local appearance state
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  applyAccentHue,
  applyTheme,
  readStoredAccentHue,
  readStoredTheme,
  storeAccentHue,
  storeTheme,
  watchSystemTheme,
  type AccentHue,
  type Theme,
} from './theme';

interface ThemeContextValue {
  theme: Theme;
  accentHue: AccentHue;
  setTheme: (theme: Theme) => void;
  setAccentHue: (hue: AccentHue) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function useThemePreference() {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    return watchSystemTheme((prefersDark) => applyTheme('system', prefersDark));
  }, [theme]);
  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    storeTheme(next);
    applyTheme(next);
  }, []);
  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      storeTheme(next);
      applyTheme(next);
      return next;
    });
  }, []);
  return { theme, setTheme, toggleTheme };
}

function useAccentPreference() {
  const [accentHue, setAccentHueState] = useState<AccentHue>(readStoredAccentHue);
  useEffect(() => applyAccentHue(accentHue), [accentHue]);
  const setAccentHue = useCallback((next: AccentHue) => {
    setAccentHueState(next);
    storeAccentHue(next);
    applyAccentHue(next);
  }, []);
  return { accentHue, setAccentHue };
}

// The no-flash script applies initial preferences before React mounts; this provider owns changes.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const themePreference = useThemePreference();
  const accentPreference = useAccentPreference();
  const value = useMemo<ThemeContextValue>(
    () => ({ ...themePreference, ...accentPreference }),
    [themePreference.theme, themePreference.setTheme, themePreference.toggleTheme,
      accentPreference.accentHue, accentPreference.setAccentHue],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function useThemeContext(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}

export function useTheme(): Theme {
  return useThemeContext().theme;
}

export function useAccentHue(): AccentHue {
  return useThemeContext().accentHue;
}

export function useSetTheme(): (theme: Theme) => void {
  return useThemeContext().setTheme;
}

export function useSetAccentHue(): (hue: AccentHue) => void {
  return useThemeContext().setAccentHue;
}

export function useToggleTheme(): () => void {
  return useThemeContext().toggleTheme;
}
