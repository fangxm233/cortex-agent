// input:  router location, current project, selected session and the pure stack rules
// output: back and forward navigation over the app's real location tuple
// pos:    App navigation stack owner behind the top bar arrows
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useSelectedSession } from '@/features/workbench/SelectedSessionProvider';
import { canGoBack, canGoForward, recordEntry, sameEntry, type NavEntry, type NavStack } from './navigation-history';

// Browser-style history over what the user actually navigates. React Router's own history only sees
// the six top-level routes; the workbench never changes path when you switch session, so route-only
// arrows would be dead in the app's main workflow. This provider records the
// (route, project, session) tuple instead — see design/desktop-titlebar §3.4.
//
// Applying an entry writes into three independent providers, and those writes come back as ordinary
// tuple changes. `applyingRef` suppresses recording until the tuple settles on the target; a timer
// releases the guard unconditionally so a target that can never be reached (a deleted session, say)
// cannot wedge the stack.
const SETTLE_TIMEOUT_MS = 1500;

export interface NavigationHistoryContextValue {
  canBack: boolean;
  canForward: boolean;
  back: () => void;
  forward: () => void;
}

const NavigationHistoryContext = createContext<NavigationHistoryContextValue | null>(null);

export function NavigationHistoryProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { currentProjectId, setCurrentProject } = useCurrentProject();
  const { selectedSessionId, setSelectedSession } = useSelectedSession();

  const [stack, setStack] = useState<NavStack>(() => ({
    entries: [{ route: pathname, projectId: currentProjectId, sessionId: selectedSessionId }],
    index: 0,
  }));
  const applyingRef = useRef<NavEntry | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of `stack` for the click handlers: `apply` navigates and starts a timer, so it must not
  // run inside a `setStack` updater (React invokes updaters twice under StrictMode).
  const stackRef = useRef(stack);
  stackRef.current = stack;

  const releaseGuard = useCallback(() => {
    applyingRef.current = null;
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => releaseGuard(), [releaseGuard]);

  // Observe the tuple. While applying, swallow every intermediate state until the target is reached.
  useEffect(() => {
    const next: NavEntry = { route: pathname, projectId: currentProjectId, sessionId: selectedSessionId };
    if (applyingRef.current) {
      if (sameEntry(applyingRef.current, next)) releaseGuard();
      return;
    }
    setStack((prev) => recordEntry(prev, next));
  }, [pathname, currentProjectId, selectedSessionId, releaseGuard]);

  const apply = useCallback((entry: NavEntry) => {
    applyingRef.current = entry;
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(releaseGuard, SETTLE_TIMEOUT_MS);
    // Project first: SelectedSessionProvider scopes its session list by project, so the session
    // override only resolves once the target project is in scope. The override survives the
    // intermediate renders, so no retry is needed — it binds as soon as the list lands.
    if (entry.projectId && entry.projectId !== currentProjectId) setCurrentProject(entry.projectId);
    if (entry.sessionId && entry.sessionId !== selectedSessionId) setSelectedSession(entry.sessionId);
    if (entry.route !== pathname) navigate(entry.route);
  }, [currentProjectId, selectedSessionId, pathname, navigate, setCurrentProject, setSelectedSession, releaseGuard]);

  const step = useCallback((delta: -1 | 1) => {
    const current = stackRef.current;
    if (delta === -1 ? !canGoBack(current) : !canGoForward(current)) return;
    const index = current.index + delta;
    apply(current.entries[index]);
    setStack({ ...current, index });
  }, [apply]);

  const back = useCallback(() => step(-1), [step]);
  const forward = useCallback(() => step(1), [step]);

  const value = useMemo(
    () => ({ canBack: canGoBack(stack), canForward: canGoForward(stack), back, forward }),
    [stack, back, forward],
  );
  return <NavigationHistoryContext.Provider value={value}>{children}</NavigationHistoryContext.Provider>;
}

export function useNavigationHistory(): NavigationHistoryContextValue {
  const context = useContext(NavigationHistoryContext);
  if (!context) {
    throw new Error('useNavigationHistory must be used within a NavigationHistoryProvider');
  }
  return context;
}
