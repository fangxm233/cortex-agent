import { useUpdatePrompt } from '@/features/update-prompt/useUpdatePrompt';
import { MAppUpdateDialog } from './MAppUpdateDialog';
import { MHotUpdateDialog } from './MHotUpdateDialog';

export function MUpdateProvider() {
  const prompt = useUpdatePrompt();
  if (!prompt) return null;
  // The server self-update dialog is a desktop/web-shell surface; a phone that only ever opens
  // the mobile SPA still gets asked through the chat-message fallback prompt.
  if (prompt.kind === 'server') return null;
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
