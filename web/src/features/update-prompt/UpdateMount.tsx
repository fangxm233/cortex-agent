import { AppUpdateDialog } from '@/features/app-update/AppUpdateDialog';
import { HotUpdateDialog } from '@/features/hot-update/HotUpdateDialog';
import { ServerUpdateDialog } from '@/features/server-update/ServerUpdateDialog';
import { useSilentUpdateNotice } from './useSilentUpdateNotice';
import { useUpdatePrompt } from './useUpdatePrompt';

/** Renders whichever single update prompt the arbitration layer picked, and nothing when there is
 *  none. It provides no context — it is the desktop shell's mount point for this feature's UI. */
export function UpdateMount() {
  const prompt = useUpdatePrompt();
  // Silent updates never reach `prompt`; a toast is their whole notification.
  useSilentUpdateNotice();
  if (!prompt) return null;
  if (prompt.kind === 'server') {
    return (
      <ServerUpdateDialog
        status={prompt.status}
        busy={prompt.busy}
        onApply={prompt.apply}
        onSkip={prompt.skip}
        onDismiss={prompt.dismiss}
      />
    );
  }
  if (prompt.kind === 'hot') {
    return (
      <HotUpdateDialog
        update={prompt.update}
        onApply={prompt.apply}
        onDismiss={prompt.dismiss}
      />
    );
  }
  return (
    <AppUpdateDialog
      update={prompt.update}
      busy={prompt.busy}
      error={prompt.error}
      onInstall={prompt.install}
      onSkip={prompt.skip}
      onDismiss={prompt.dismiss}
    />
  );
}
