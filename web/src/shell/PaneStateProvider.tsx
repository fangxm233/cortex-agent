import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

// The left rail and right panel own their own width, but their COLLAPSED flags are window-level:
// the top bar's rail toggle and the View menu drive them from outside the panes. Both flags used to
// be module-private `useState` inside LeftRail/RightPanel, unreachable from anywhere else. The
// localStorage keys are unchanged, so an existing install keeps its layout across this refactor.
const RAIL_COLLAPSED_KEY = 'cortex:left-rail-collapsed';
const PANEL_COLLAPSED_KEY = 'cortex:right-panel-collapsed';
// The right panel starts collapsed on a fresh install: it is a secondary surface, and the chat
// column deserves the width until the user asks for it. The rail keeps its expanded default.
// Only the absence of a stored value takes this default — an existing install keeps its choice.
const PANEL_COLLAPSED_DEFAULT = true;

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
  panelCollapsed: boolean;
  setPanelCollapsed: (next: boolean) => void;
  togglePanel: () => void;
}

const PaneStateContext = createContext<PaneStateContextValue | null>(null);

export function PaneStateProvider({ children }: { children: ReactNode }) {
  const [railCollapsed, setRail] = usePersistedFlag(RAIL_COLLAPSED_KEY);
  const [panelCollapsed, setPanel] = usePersistedFlag(PANEL_COLLAPSED_KEY, PANEL_COLLAPSED_DEFAULT);

  const setRailCollapsed = useCallback((next: boolean) => setRail(next), [setRail]);
  const toggleRail = useCallback(() => setRail((prev) => !prev), [setRail]);
  const setPanelCollapsed = useCallback((next: boolean) => setPanel(next), [setPanel]);
  const togglePanel = useCallback(() => setPanel((prev) => !prev), [setPanel]);

  const value = useMemo(
    () => ({ railCollapsed, setRailCollapsed, toggleRail, panelCollapsed, setPanelCollapsed, togglePanel }),
    [railCollapsed, setRailCollapsed, toggleRail, panelCollapsed, setPanelCollapsed, togglePanel],
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
