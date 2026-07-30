import { useAppUpdate } from '@/features/app-update/useAppUpdate';
import { MAppUpdateDialog } from './MAppUpdateDialog';

// Mobile app shell update prompt wiring. Mounted globally in MobileShell. Shares the desktop pure
// app-update layer (bridge + useAppUpdate); only the presentation differs. Off-shell (plain
// browser) the bridge is a no-op so nothing renders. While an app update is pending the hot-update
// prompt stands down, so the user only ever sees ONE update dialog.
export function MAppUpdateProvider() {
  const { update, busy, error, install, skip, dismiss } = useAppUpdate();
  if (!update) return null;
  return (
    <MAppUpdateDialog
      update={update}
      busy={busy}
      error={error}
      onInstall={install}
      onSkip={skip}
      onDismiss={dismiss}
    />
  );
}
