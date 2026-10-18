import { useSyncExternalStore } from 'react';

// How a finished turn's work shows in the chat: folded into its summary line (the default), or
// always open. A reading preference of this device, like the theme, so it lives in local storage;
// the settings panels write it and every chat stream reads it.

export type WorkLogMode = 'fold' | 'expanded';

const KEY = 'cortex.chat-work-log';
const listeners = new Set<() => void>();
let mode: WorkLogMode | undefined;

function snapshot(): WorkLogMode {
  if (mode === undefined) {
    try { mode = window.localStorage.getItem(KEY) === 'expanded' ? 'expanded' : 'fold'; } catch { mode = 'fold'; }
  }
  return mode;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setWorkLogMode(next: WorkLogMode): void {
  if (next === snapshot()) return;
  mode = next;
  try { window.localStorage.setItem(KEY, next); } catch { /* persistence is best-effort */ }
  for (const listener of [...listeners]) listener();
}

export function useWorkLogMode(): WorkLogMode {
  return useSyncExternalStore(subscribe, snapshot, () => 'fold');
}
