// input:  React lifecycle, Router state, and canonical native back capability
// output: mobile back policy, semantic navigation, and idempotent Android listener cleanup
// pos:    Android navigation control without local native-global declarations
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useEffect, useRef } from 'react';
import { listenNativeBack, safeInvoke } from '@/lib/native-bridge';
import { isTabRootRoute, normalizeMobilePath } from './mobile-tabs';

export type MobileNavigate = (to: string, options?: { replace: boolean }) => void;
export type MobileBackAction =
  | { kind: 'history' }
  | { kind: 'exit' }
  | { kind: 'navigate'; to: string };

interface ParentRule {
  pattern: RegExp;
  parent: string | ((match: RegExpMatchArray) => string);
}

const PARENT_RULES: readonly ParentRule[] = [
  { pattern: /^\/m\/session\/([^/]+)\/plan\/[^/]+$/, parent: (m) => `/m/session/${m[1]}` },
  { pattern: /^\/m\/session\/[^/]+$/, parent: '/m/sessions' },
  { pattern: /^\/m\/thread\/[^/]+$/, parent: '/m/threads' },
  { pattern: /^\/m\/task\/[^/]+$/, parent: '/m/tasks' },
  { pattern: /^\/m\/memory\/file$/, parent: '/m/memory' },
  { pattern: /^\/m\/settings\/[^/]+$/, parent: '/m/settings' },
  { pattern: /^\/m\/daemon$/, parent: '/m/settings' },
  { pattern: /^\/m\/(approvals|issues|notes|memory|machines|settings)$/, parent: '/m/project' },
];

function parentPath(pathname: string): string {
  const path = normalizeMobilePath(pathname);
  for (const rule of PARENT_RULES) {
    const match = path.match(rule.pattern);
    if (match) return typeof rule.parent === 'string' ? rule.parent : rule.parent(match);
  }
  return '/m/sessions';
}

export function resolveMobileBack(
  pathname: string,
  overlayActive: boolean,
  canGoBack = false,
): MobileBackAction {
  if (overlayActive) return { kind: 'history' };
  if (isTabRootRoute(pathname)) return { kind: 'exit' };
  if (canGoBack) return { kind: 'history' };
  return { kind: 'navigate', to: parentPath(pathname) };
}

export function hasRouterHistory(
  webviewCanGoBack: boolean,
  state: { idx?: unknown } | null,
): boolean {
  return webviewCanGoBack && typeof state?.idx === 'number' && state.idx > 0;
}

export interface MobileBackDeps {
  historyBack: () => void;
  exit: () => unknown | Promise<unknown>;
  navigate: MobileNavigate;
}

export async function runMobileBack(
  pathname: string,
  overlayActive: boolean,
  canGoBack: boolean,
  deps: MobileBackDeps,
): Promise<void> {
  const action = resolveMobileBack(pathname, overlayActive, canGoBack);
  if (action.kind === 'history') return deps.historyBack();
  if (action.kind === 'exit') return void (await deps.exit());
  deps.navigate(action.to, { replace: true });
}

export function switchMobileTab(path: string, navigate: MobileNavigate): void {
  navigate(path, { replace: true });
}

function nativeCanGoBack(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  return Reflect.get(payload, 'canGoBack') === true;
}

async function exitNativeApp(): Promise<void> {
  await safeInvoke('plugin:app|exit');
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
    }).catch(() => {});
  }), []);
}
