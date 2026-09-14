import { useUpdatePrompt } from '@/features/update/useUpdatePrompt';
import { MAppUpdateDialog } from './MAppUpdateDialog';
import { MHotUpdateDialog } from './MHotUpdateDialog';

export function MUpdateProvider() {
  const prompt = useUpdatePrompt();
  if (!prompt) return null;
  if (prompt.kind === 'hot') {
    return (
      <MHotUpdateDialog
        update={prompt.update}
        onApply={prompt.apply}
        onDismiss={prompt.dismiss}
      />
    );
  }
  return (
    <MAppUpdateDialog
      update={prompt.update}
      busy={prompt.busy}
      error={prompt.error}
      onInstall={prompt.install}
      onSkip={prompt.skip}
      onDismiss={prompt.dismiss}
    />
  );
}
