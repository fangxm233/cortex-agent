import { useAppUpdate } from './useAppUpdate';
import { AppUpdateDialog } from './AppUpdateDialog';

// Desktop app shell update prompt wiring. Mounted globally in AppShell. Off-shell (browser /
// ui-http) the underlying bridge is a no-op so nothing renders — the prompt is APP-only. While an
// app update is pending, the hot-update prompt stands down (it reads the same store) so the user
// only ever sees ONE update dialog.
export function AppUpdateProvider() {
  const { update, busy, error, install, skip, dismiss } = useAppUpdate();
  if (!update) return null;
  return (
    <AppUpdateDialog
      update={update}
      busy={busy}
      error={error}
      onInstall={install}
      onSkip={skip}
      onDismiss={dismiss}
    />
  );
}
