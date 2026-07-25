import { Outlet } from 'react-router-dom';
import { CommandPalette } from '@/features/command-palette/CommandPalette';
import { useCommandPalette } from '@/features/command-palette/useCommandPalette';
import { ExecutionLogDrawerProvider } from '@/features/execution/ExecutionLogDrawerProvider';
import { ScheduleModalProvider } from '@/features/schedule/ScheduleModalProvider';
import { ApprovalsProvider } from '@/features/approvals/ApprovalsProvider';
import { IssuesProvider } from '@/features/issues/IssuesProvider';
import { CurrentProjectProvider } from '@/features/workbench/CurrentProjectProvider';
import { SelectedSessionProvider } from '@/features/workbench/SelectedSessionProvider';
import { NotificationProvider } from '@/features/notifications/NotificationProvider';
import { HotUpdateProvider } from '@/features/hot-update/HotUpdateProvider';
import { MediaViewerProvider } from '@/features/media/MediaViewer';
import { DocViewerProvider } from '@/features/media/DocViewer';
import { PinnedPreviewProvider } from '@/features/media/PinnedPreviewProvider';
import { ConnectionStatusProvider } from '@/features/connection/ConnectionStatusProvider';

// App shell (Stage-R RB, task f528): a pass-through layout. The prototype is a single full-screen
// frame owned by each view — `/workbench` (WorkbenchPage) renders the 240/fluid/400 three-pane
// frame including its own left rail; other routes render full-bleed. The old token-summary nav
// LeftRail was removed (superseded). The global ⌘K command palette (design 6c), the execution
// log drawer (design 09-exec-logs), the New-schedule overlay (design 7c) and the approval center
// overlay (design 7a) stay mounted here so any surface / banner / dispatch row / approval card can
// open them. PinnedPreviewProvider wraps both previewers because they consult it: while a preview is
// pinned (docked beside the chat on the workbench) `openMedia`/`openDoc` swap that pane instead of
// raising their modal.
export function AppShell() {
  const { open, setOpen } = useCommandPalette();
  return (
    <ConnectionStatusProvider>
      <CurrentProjectProvider>
        <SelectedSessionProvider>
          <ExecutionLogDrawerProvider>
            <ScheduleModalProvider>
              <ApprovalsProvider>
                <IssuesProvider>
                  <PinnedPreviewProvider>
                    <MediaViewerProvider>
                      <DocViewerProvider>
                        <Outlet />
                        <CommandPalette open={open} onOpenChange={setOpen} />
                        <NotificationProvider />
                        <HotUpdateProvider />
                      </DocViewerProvider>
                    </MediaViewerProvider>
                  </PinnedPreviewProvider>
                </IssuesProvider>
              </ApprovalsProvider>
            </ScheduleModalProvider>
          </ExecutionLogDrawerProvider>
        </SelectedSessionProvider>
      </CurrentProjectProvider>
    </ConnectionStatusProvider>
  );
}
