// input:  persisted collapse flags for the workbench side panes
// output: shared collapse state and setters for rail, panel and their toggles
// pos:    Window-level pane layout state owner, readable by the top bar
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

// The left rail and right panel own their own width, but their COLLAPSED flags are window-level:
// the top bar's rail toggle and the View menu drive them from outside the panes. Both flags used to
// be module-private `useState` inside LeftRail/RightPanel, unreachable from anywhere else. The
// localStorage keys are unchanged, so an existing install keeps its layout across this refactor.
const RAIL_COLLAPSED_KEY = 'cortex:left-rail-collapsed';
const PANEL_COLLAPSED_KEY = 'cortex:right-panel-collapsed';

function usePersistedFlag(key: string): readonly [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(key) === 'true';
    } catch {
      return false;
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
  const [panelCollapsed, setPanel] = usePersistedFlag(PANEL_COLLAPSED_KEY);

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
