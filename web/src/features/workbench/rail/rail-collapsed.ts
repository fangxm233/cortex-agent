import { useSyncExternalStore } from 'react';

// The rail's collapsed flag. The rail owns it, but the top bar's toggle and the View menu drive it
// from outside the pane, so it lives in a small persisted store rather than in rail state.
const KEY = 'cortex:left-rail-collapsed';
const listeners = new Set<() => void>();
let collapsed: boolean | undefined;

function snapshot(): boolean {
  if (collapsed === undefined) {
    try { collapsed = window.localStorage.getItem(KEY) === 'true'; } catch { collapsed = false; }
  }
  return collapsed;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setRailCollapsed(next: boolean): void {
  if (next === snapshot()) return;
  collapsed = next;
  try { window.localStorage.setItem(KEY, String(next)); } catch { /* persistence is best-effort */ }
  for (const listener of [...listeners]) listener();
}

export function toggleRail(): void {
  setRailCollapsed(!snapshot());
}

export function useRailCollapsed(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
