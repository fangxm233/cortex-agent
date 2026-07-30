import { useSyncExternalStore } from 'react';
import { getAppUpdateSnapshot, subscribeAppUpdate } from '@/features/app-update/app-update';
import { useHotUpdate } from './useHotUpdate';
import { HotUpdateDialog } from './HotUpdateDialog';

// Desktop hot-update prompt wiring (design 21a). Mounted globally in AppShell. Off-shell (browser /
// ui-http) the underlying seam is a no-op so `staged` stays null and nothing renders — the prompt is
// APP-only. Applying restarts the desktop app (Rust `apply_frontend_update` → `app.restart()`).
// While a full app shell update is pending, this prompt stands down (the shell update supersedes it:
// the new shell ships a fresh SPA seed and OTA converges the rest) so only ONE update dialog shows.
export function HotUpdateProvider() {
  const appUpdate = useSyncExternalStore(subscribeAppUpdate, getAppUpdateSnapshot);
  const { staged, apply, dismiss } = useHotUpdate();
  if (appUpdate || !staged) return null;
  return <HotUpdateDialog update={staged} onApply={apply} onDismiss={dismiss} />;
}
