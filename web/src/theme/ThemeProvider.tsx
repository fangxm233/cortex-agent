// input:  React context, persisted theme helpers, system color scheme
// output: ThemeProvider and hooks for reading or changing theme
// pos:    React owner for global color-theme preference
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { applyTheme, readStoredTheme, storeTheme, watchSystemTheme, type Theme } from './theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// The no-flash script applies the initial preference before React mounts. This provider persists
// explicit choices and keeps the document in sync with OS changes while system mode is selected.
export function ThemeProvider({ children }: { children: ReactNode }) {
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

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
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

export function useSetTheme(): (theme: Theme) => void {
  return useThemeContext().setTheme;
}

export function useToggleTheme(): () => void {
  return useThemeContext().toggleTheme;
}
