import { useHotUpdate } from '@/features/hot-update/useHotUpdate';
import { MHotUpdateDialog } from './MHotUpdateDialog';

// Mobile hot-update prompt wiring (design 3a). Mounted globally in MobileShell. Shares the desktop
// pure hot-update layer (seam + useHotUpdate); only the presentation differs (3a full-width alert).
// Off-shell (plain browser) the seam is a no-op so nothing renders — the prompt is APP-only. Applying
// exits the app on Android (Rust `apply_frontend_update` → `app.exit(0)`); the system relaunch applies
// the staged update.
export function MHotUpdateProvider() {
  const { staged, apply, dismiss } = useHotUpdate();
  if (!staged) return null;
  return <MHotUpdateDialog update={staged} onApply={apply} onDismiss={dismiss} />;
}
