import { AppUpdateDialog } from '@/features/app-update/AppUpdateDialog';
import { HotUpdateDialog } from '@/features/hot-update/HotUpdateDialog';
import { ServerUpdateDialog } from './ServerUpdateDialog';
import { useSilentUpdateNotice } from './useSilentUpdateNotice';
import { useUpdatePrompt } from './useUpdatePrompt';

export function UpdateProvider() {
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
