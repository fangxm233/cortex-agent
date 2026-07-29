// input:  React lifecycle, Router and Tauri bridge
// output: mobile back policy, hook and tab switch
// pos:    Android navigation control
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useEffect, useRef } from 'react';
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
  { pattern: /^\/m\/settings\/hooks$/, parent: '/m/settings' },
  { pattern: /^\/m\/daemon$/, parent: '/m/settings' },
  { pattern: /^\/m\/(approvals|issues|memory|machines|settings)$/, parent: '/m/project' },
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

interface NativeBackListener {
  unregister: () => Promise<void>;
}

interface NativeBackPayload {
  canGoBack: boolean;
}

interface NativeBridge {
  listen: (handler: (payload: NativeBackPayload) => void) => Promise<NativeBackListener>;
  exit: () => Promise<unknown>;
}

function readNativeBridge(): NativeBridge | null {
  const tauri = (globalThis as unknown as {
    __TAURI__?: {
      app?: {
        onBackButtonPress: (handler: (payload: NativeBackPayload) => void) => Promise<NativeBackListener>;
      };
      core?: { invoke: (command: string) => Promise<unknown> };
    };
  }).__TAURI__;
  if (!tauri?.app || !tauri.core) return null;
  return {
    listen: (handler) => tauri.app!.onBackButtonPress(handler),
    exit: () => tauri.core!.invoke('plugin:app|exit'),
  };
}

function overlayActive(): boolean {
  const state = window.history.state as { __cortexOverlay?: boolean } | null;
  return state?.__cortexOverlay === true;
}

export function registerNativeBack(
  bridge: NativeBridge,
  handler: (payload: NativeBackPayload) => void,
): () => void {
  let disposed = false;
  let listener: NativeBackListener | null = null;
  void bridge.listen(handler).then((next) => {
    if (disposed) void next.unregister().catch(() => {});
    else listener = next;
  }).catch(() => {});
  return () => {
    disposed = true;
    if (listener) void listener.unregister().catch(() => {});
  };
}

export function useMobileBackNavigation(pathname: string, navigate: MobileNavigate): void {
  const latest = useRef({ pathname, navigate });
  latest.current = { pathname, navigate };
  useEffect(() => {
    const bridge = readNativeBridge();
    if (!bridge) return;
    return registerNativeBack(bridge, (payload) => {
      const current = latest.current;
      const routerHistory = window.history.state as { idx?: unknown } | null;
      const canGoBack = hasRouterHistory(payload.canGoBack, routerHistory);
      void runMobileBack(current.pathname, overlayActive(), canGoBack, {
        historyBack: () => window.history.back(),
        exit: bridge.exit,
        navigate: current.navigate,
      }).catch(() => {});
    });
  }, []);
}
