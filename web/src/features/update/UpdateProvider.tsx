import { AppUpdateDialog } from '@/features/app-update/AppUpdateDialog';
import { HotUpdateDialog } from '@/features/hot-update/HotUpdateDialog';
import { useUpdatePrompt } from './useUpdatePrompt';

export function UpdateProvider() {
  const prompt = useUpdatePrompt();
  if (!prompt) return null;
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
