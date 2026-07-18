import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { applyTheme, readStoredTheme, storeTheme, type Theme } from './theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// Theme is a real, user-controlled, persisted choice (the light/dark toggle in Settings) — NOT
// derived from viewport. It defaults to the OS `prefers-color-scheme` on first run, then sticks to
// the user's explicit choice (see resolveInitialTheme). The no-flash inline script in index.html
// already applied the correct `data-theme` before first paint; this provider keeps React state in
// sync and re-applies on change.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);

  // Keep the document root attribute in sync with React state (covers the initial mount too, in
  // case the pre-paint script did not run, e.g. plain SSR hydration).
  useEffect(() => {
    applyTheme(theme);
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
