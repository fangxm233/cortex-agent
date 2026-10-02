import { useSyncExternalStore } from 'react';
import { isNativeShell } from '@/lib/desktop-config';
import { subscribeManualCheckResult } from '@/lib/manual-update-check-result';
import { useUpdateGating } from '@/lib/useUpdateGating';
import { reloadBrowserPage, type BrowserPageUpdate } from './browser-update';

// The loaded document outlives desktop/mobile shell remounts. Only its page result is retained.
let pending: BrowserPageUpdate | null = null;
const listeners = new Set<() => void>();
const getSnapshot = () => pending;
function setPending(update: BrowserPageUpdate | null): void {
  pending = update;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const dismiss = () => setPending(null);

subscribeManualCheckResult<BrowserPageUpdate>(({ ui }) => {
  if (isNativeShell()) return;
  if (ui.status === 'available' && ui.update?.kind === 'browser-page') setPending(ui.update);
  if (ui.status === 'current') setPending(null);
});

export function useBrowserUpdate() {
  const update = useUpdateGating(useSyncExternalStore(subscribe, getSnapshot));
  return { update, dismiss, apply: reloadBrowserPage };
}
