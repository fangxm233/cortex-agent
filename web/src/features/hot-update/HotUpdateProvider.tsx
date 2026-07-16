import { useHotUpdate } from './useHotUpdate';
import { HotUpdateDialog } from './HotUpdateDialog';

// Desktop hot-update prompt wiring (design 21a). Mounted globally in AppShell. Off-shell (browser /
// ui-http) the underlying seam is a no-op so `staged` stays null and nothing renders — the prompt is
// APP-only. Applying restarts the desktop app (Rust `apply_frontend_update` → `app.restart()`).
export function HotUpdateProvider() {
  const { staged, apply, dismiss } = useHotUpdate();
  if (!staged) return null;
  return <HotUpdateDialog update={staged} onApply={apply} onDismiss={dismiss} />;
}
