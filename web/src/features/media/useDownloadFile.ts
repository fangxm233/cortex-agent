import { useCallback } from 'react';
import { useToastOptional } from '@/design';
import type { ToastAction } from '@/design';
import { useVocabOptional } from '@/i18n';
import { downloadFile, openPath, revealPath } from '@/lib/files';
import { isMobileShell } from '@/lib/desktop-config';

//
// Mobile native shell is intentionally skipped: Android surfaces its own OS notification
// (`save_download` / DownloadManager), so an in-app bubble would only repeat it. There the plain
// `downloadFile` runs and the OS notification is the feedback.

export function useDownloadFile(): (relPath: string, name?: string) => void {
  // Optional so a consumer rendered bare in an isolated test (no ToastProvider / LangProvider) still
  // works — it just downloads without a toast. In the real app both providers are always in scope.
  const toastCtx = useToastOptional();
  const L = useVocabOptional();

  return useCallback(
    (relPath: string, name?: string) => {
      void (async () => {
        if (isMobileShell()) {
          // Android's OS notification is the feedback; swallow errors so one failed file in a batch
          // does not reject the whole forEach.
          await downloadFile(relPath, name).catch(() => undefined);
          return;
        }
        const fallbackName = name ?? relPath.split('/').pop() ?? relPath;
        try {
          const { savedPath } = await downloadFile(relPath, name);
          // Desktop native shell returns the absolute on-disk path → offer Open file / Open folder
          // actions (they invoke the `open_path` / `reveal_path` Tauri commands). The browser has no
          // observable location, so it just shows the file name with no actions.
          const actions: ToastAction[] | undefined = savedPath
            ? [
                { label: L.wbFileOpenFile, onClick: () => void openPath(savedPath) },
                { label: L.wbFileOpenFolder, onClick: () => void revealPath(savedPath) },
              ]
            : undefined;
          toastCtx?.toast({
            title: L.wbFileDownloadDone,
            description: savedPath
              ? L.wbFileSavedTo.replace('{path}', savedPath)
              : fallbackName,
            tone: 'done',
            // Give the user time to reach the action buttons (the stack pauses the timer on hover).
            duration: actions ? 10_000 : undefined,
            actions,
          });
        } catch (err) {
          toastCtx?.toast({
            title: L.wbFileDownloadFailed,
            description: err instanceof Error ? err.message : String(err),
            tone: 'failed',
          });
        }
      })();
    },
    [toastCtx, L],
  );
}
