// input:  Router outlet and global UI/modal/note providers
// output: Persistent desktop application shell
// pos:    Keeps shared state and task/thread overlays across routes
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { Outlet } from 'react-router-dom';
import { CommandPalette } from '@/features/command-palette/CommandPalette';
import { useCommandPalette } from '@/features/command-palette/useCommandPalette';
import { ExecutionLogDrawerProvider } from '@/features/execution/ExecutionLogDrawerProvider';
import { ScheduleModalProvider } from '@/features/schedule/ScheduleModalProvider';
import { ApprovalsProvider } from '@/features/approvals/ApprovalsProvider';
import { SettingsProvider } from '@/features/settings/SettingsProvider';
import { IssuesProvider } from '@/features/issues/IssuesProvider';
import { CurrentProjectProvider } from '@/features/workbench/CurrentProjectProvider';
import { SelectedSessionProvider } from '@/features/workbench/SelectedSessionProvider';
import { NotificationProvider } from '@/features/notifications/NotificationProvider';
import { HotUpdateProvider } from '@/features/hot-update/HotUpdateProvider';
import { AppUpdateProvider } from '@/features/app-update/AppUpdateProvider';
import { MediaViewerProvider } from '@/features/media/MediaViewer';
import { DocViewerProvider } from '@/features/media/DocViewer';
import { PinnedPreviewProvider } from '@/features/media/PinnedPreviewProvider';
import { ConnectionStatusProvider } from '@/features/connection/ConnectionStatusProvider';
import { LiveEventsProvider } from '@/features/live/LiveEventsProvider';
import { ThreadDetailModalProvider } from '@/features/thread/ThreadDetailModal';
import { TaskModalProvider } from '@/features/tasks/TaskModalProvider';
import { NotesProvider } from '@/features/notes/NotesProvider';

// App shell (Stage-R RB, task f528): a pass-through layout. The prototype is a single full-screen
// frame owned by each view — `/workbench` (WorkbenchPage) renders the 240/fluid/400 three-pane
// frame including its own left rail; other routes render full-bleed. The old token-summary nav
// LeftRail was removed (superseded). The global ⌘K command palette (design 6c), the execution
// log drawer, thread detail, Settings, New-schedule and approval overlays stay mounted here so any
// surface can open them without route navigation. PinnedPreviewProvider wraps both previewers: while a preview is
// pinned (docked beside the chat on the workbench) `openMedia`/`openDoc` swap that pane instead of
// raising their modal. LiveEventsProvider is OUTERMOST: it owns the app's single SSE stream, which
// every live surface (and the connectivity badge) reads through — see features/live/CORTEX.md.
export function AppShell() {
  const { open, setOpen } = useCommandPalette();
  return (
    <LiveEventsProvider><ConnectionStatusProvider>
      <CurrentProjectProvider><SelectedSessionProvider><NotesProvider>
        <ExecutionLogDrawerProvider><ScheduleModalProvider>
          <ApprovalsProvider><SettingsProvider><IssuesProvider>
            <ThreadDetailModalProvider><TaskModalProvider><PinnedPreviewProvider>
              <MediaViewerProvider><DocViewerProvider>
                <Outlet />
                <CommandPalette open={open} onOpenChange={setOpen} />
                <NotificationProvider />
                <HotUpdateProvider />
                <AppUpdateProvider />
              </DocViewerProvider></MediaViewerProvider>
            </PinnedPreviewProvider></TaskModalProvider></ThreadDetailModalProvider>
          </IssuesProvider></SettingsProvider></ApprovalsProvider>
        </ScheduleModalProvider></ExecutionLogDrawerProvider>
      </NotesProvider></SelectedSessionProvider></CurrentProjectProvider>
    </ConnectionStatusProvider></LiveEventsProvider>
  );
}
