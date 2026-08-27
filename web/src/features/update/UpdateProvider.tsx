// input:  shared prioritized update prompt and desktop update dialogs
// output: at most one desktop update overlay
// pos:    Consolidated desktop provider for shell and frontend updates
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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
