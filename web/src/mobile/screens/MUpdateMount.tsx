import { ServerUpdateDialog } from '@/features/server-update/ServerUpdateDialog';
import { BrowserUpdateDialog } from '@/features/hot-update/BrowserUpdateDialog';
import { useUpdatePrompt } from '@/features/update-prompt/useUpdatePrompt';
import { MAppUpdateDialog } from './MAppUpdateDialog';
import { MHotUpdateDialog } from './MHotUpdateDialog';

/** The mobile chrome's mount point for the update prompt — no context, just this chrome's dialogs. */
export function MUpdateMount() {
  const prompt = useUpdatePrompt();
  if (!prompt) return null;
  // These frames are width-constrained to the viewport and share the same consent actions.
  if (prompt.kind === 'page') return <BrowserUpdateDialog onApply={prompt.apply} onDismiss={prompt.dismiss} />;
  if (prompt.kind === 'server') return <ServerUpdateDialog status={prompt.status} busy={prompt.busy}
    onApply={prompt.apply} onSkip={prompt.skip} onDismiss={prompt.dismiss} />;
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
