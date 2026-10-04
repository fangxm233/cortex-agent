import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

// The left rail owns its own width, but its COLLAPSED flag is window-level: the top bar's rail
// toggle and the View menu drive it from outside the pane.
const RAIL_COLLAPSED_KEY = 'cortex:left-rail-collapsed';

function usePersistedFlag(
  key: string,
  fallback = false,
): readonly [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? fallback : stored === 'true';
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      /* persistence is best-effort */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

export interface PaneStateContextValue {
  railCollapsed: boolean;
  setRailCollapsed: (next: boolean) => void;
  toggleRail: () => void;
}

const PaneStateContext = createContext<PaneStateContextValue | null>(null);

export function PaneStateProvider({ children }: { children: ReactNode }) {
  const [railCollapsed, setRail] = usePersistedFlag(RAIL_COLLAPSED_KEY);

  const setRailCollapsed = useCallback((next: boolean) => setRail(next), [setRail]);
  const toggleRail = useCallback(() => setRail((prev) => !prev), [setRail]);

  const value = useMemo(
    () => ({ railCollapsed, setRailCollapsed, toggleRail }),
    [railCollapsed, setRailCollapsed, toggleRail],
  );
  return <PaneStateContext.Provider value={value}>{children}</PaneStateContext.Provider>;
}

export function usePaneState(): PaneStateContextValue {
  const context = useContext(PaneStateContext);
  if (!context) {
    throw new Error('usePaneState must be used within a PaneStateProvider');
  }
  return context;
}
