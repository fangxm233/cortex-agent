import { useCallback, useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { listenNativeBack, safeInvoke } from '@/lib/native-bridge';
import { mobileHomeView, mobileRouteParentPath, mobileRoutePath } from './mobile-route-manifest';

export type MobileNavigate = (to: string, options?: { replace: boolean }) => void;
export type MobileBackAction =
  | { kind: 'history' }
  | { kind: 'exit' }
  | { kind: 'navigate'; to: string };

function parentPath(pathname: string): string {
  return mobileRouteParentPath(pathname) ?? mobileRoutePath('sessions');
}

export function resolveMobileBack(
  pathname: string,
  overlayActive: boolean,
  canGoBack = false,
): MobileBackAction {
  if (overlayActive) return { kind: 'history' };
  const home = mobileHomeView(pathname);
  if (home === 'list') return { kind: 'exit' };
  // The open Projects panel closes in place, whatever history led here.
  if (home === 'projects') return { kind: 'navigate', to: mobileRoutePath('sessions') };
  if (canGoBack) return { kind: 'history' };
  return { kind: 'navigate', to: parentPath(pathname) };
}

export function hasRouterHistory(
  webviewCanGoBack: boolean,
  state: { idx?: unknown } | null,
): boolean {
  return webviewCanGoBack && typeof state?.idx === 'number' && state.idx > 0;
}

export function mobileHeaderBack(
  navigate: NavigateFunction, parent: string,
  state: { idx?: unknown } | null = globalThis.history?.state ?? null,
): void {
  if (hasRouterHistory(true, state)) navigate(-1);
  else navigate(parent, { replace: true });
}

export interface MobileBackDeps {
  historyBack: () => void;
  exit: () => unknown | Promise<unknown>;
  navigate: MobileNavigate;
  /** False when the screen being left holds unsaved changes the user chose to keep. */
  canLeave?: () => boolean;
}

export async function runMobileBack(
  pathname: string,
  overlayActive: boolean,
  canGoBack: boolean,
  deps: MobileBackDeps,
): Promise<void> {
  const action = resolveMobileBack(pathname, overlayActive, canGoBack);
  // Dismissing an overlay stays on the screen, so only leaving it asks the screen first.
  if (!overlayActive && deps.canLeave && !deps.canLeave()) return;
  if (action.kind === 'history') return deps.historyBack();
  if (action.kind === 'exit') return void (await deps.exit());
  deps.navigate(action.to, { replace: true });
}

/** Open or close the home's Projects panel. Replace, so the panel never adds a history entry. */
export function setProjectsPanel(open: boolean, navigate: MobileNavigate): void {
  navigate(mobileRoutePath(open ? 'project' : 'sessions'), { replace: true });
}

function nativeCanGoBack(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  return Reflect.get(payload, 'canGoBack') === true;
}

async function exitNativeApp(): Promise<void> {
  await safeInvoke('plugin:app|exit', { code: 0 });
}

// Screens holding unsaved edits register here so the system back button asks the same question
// their header back button does.
const leaveGuards = new Set<() => boolean>();

export function confirmMobileLeave(): boolean {
  for (const guard of leaveGuards) if (!guard()) return false;
  return true;
}

/** Asks `message` before the screen is left while `dirty`; returns the check for the screen's
 *  own back button. */
export function useMobileLeaveGuard(dirty: boolean, message: string): () => boolean {
  const latest = useRef({ dirty, message });
  latest.current = { dirty, message };
  const guard = useCallback(() => !latest.current.dirty || window.confirm(latest.current.message), []);
  useEffect(() => {
    leaveGuards.add(guard);
    return () => { leaveGuards.delete(guard); };
  }, [guard]);
  return guard;
}

function overlayActive(): boolean {
  const state = window.history.state as { __cortexOverlay?: boolean } | null;
  return state?.__cortexOverlay === true;
}

export function useMobileBackNavigation(pathname: string, navigate: MobileNavigate): void {
  const latest = useRef({ pathname, navigate });
  latest.current = { pathname, navigate };
  useEffect(() => listenNativeBack((payload) => {
    const current = latest.current;
    const routerHistory = window.history.state as { idx?: unknown } | null;
    const canGoBack = hasRouterHistory(nativeCanGoBack(payload), routerHistory);
    void runMobileBack(current.pathname, overlayActive(), canGoBack, {
      historyBack: () => window.history.back(),
      exit: exitNativeApp,
      navigate: current.navigate,
      canLeave: confirmMobileLeave,
    }).catch(() => {});
  }), []);
}
