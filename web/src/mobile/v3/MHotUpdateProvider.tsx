import { useSyncExternalStore } from 'react';
import { getAppUpdateSnapshot, subscribeAppUpdate } from '@/features/app-update/app-update';
import { useHotUpdate } from '@/features/hot-update/useHotUpdate';
import { MHotUpdateDialog } from './MHotUpdateDialog';

// Mobile hot-update prompt wiring (design 3a). Mounted globally in MobileShell. Shares the desktop
// pure hot-update layer (seam + useHotUpdate); only the presentation differs (3a full-width alert).
// Off-shell (plain browser) the seam is a no-op so nothing renders — the prompt is APP-only. Applying
// exits the app on Android (Rust `apply_frontend_update` → `app.exit(0)`); the system relaunch applies
// the staged update. While a full app shell update is pending, this prompt stands down (the shell
// update supersedes it) so only ONE update dialog shows.
export function MHotUpdateProvider() {
  const appUpdate = useSyncExternalStore(subscribeAppUpdate, getAppUpdateSnapshot);
  const { staged, apply, dismiss } = useHotUpdate();
  if (appUpdate || !staged) return null;
  return <MHotUpdateDialog update={staged} onApply={apply} onDismiss={dismiss} />;
}
