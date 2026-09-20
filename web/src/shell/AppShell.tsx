import { Outlet } from 'react-router-dom';
import { ModalRegistryProvider } from '@/design/modal-registry';
import { CommandPalette } from '@/features/command-palette/CommandPalette';
import { useCommandPalette } from '@/features/command-palette/useCommandPalette';
import { CurrentProjectProvider } from '@/features/projects/CurrentProjectProvider';
import { SelectedSessionProvider } from '@/features/session/state/SelectedSessionProvider';
import { NotificationProvider } from '@/features/notifications/NotificationProvider';
import { UpdateProvider } from '@/features/update-prompt/UpdateProvider';
import { MediaViewerProvider } from '@/features/media/MediaViewer';
import { DocViewerProvider } from '@/features/media/DocViewer';
import { DockProvider } from '@/features/dock/DockProvider';
import { ConnectionStatusProvider } from '@/features/connection/ConnectionStatusProvider';
import { LiveEventsProvider } from '@/features/live/LiveEventsProvider';
import { NotesProvider } from '@/features/notes/NotesProvider';
import { PaneStateProvider } from './PaneStateProvider';
import { NavigationHistoryProvider } from './NavigationHistoryProvider';
import { ShellModalHost } from './ShellModals';

// App shell (Stage-R RB, task f528): a pass-through layout. The prototype is a single full-screen
// frame owned by each view — `/workbench` (WorkbenchPage) renders the 240/fluid/400 three-pane
// frame including its own left rail; other routes render full-bleed. The old token-summary nav
// LeftRail was removed (superseded). The global ⌘K command palette (design 6c) and every
// always-available overlay — the execution log drawer, thread detail, Settings, New-schedule,
// approvals, … — stay mounted here so any surface can open them without route navigation. The
// overlays no longer bring a provider each: they share one ModalRegistryProvider and are rendered
// by ShellModalHost. DockProvider wraps both previewers: while the dock is open (the tabbed pane
// beside the chat on the workbench) `openMedia`/`openDoc` open a tab in it instead of raising their
// modal. LiveEventsProvider is OUTERMOST: it owns the app's single SSE stream, which every live
// surface (and the connectivity badge) reads through — see features/live/CORTEX.md.
export function AppShell() {
  const { open, setOpen } = useCommandPalette();
  return (
    <LiveEventsProvider><ConnectionStatusProvider>
      <CurrentProjectProvider><ModalRegistryProvider>
        <SelectedSessionProvider><NavigationHistoryProvider><PaneStateProvider><NotesProvider>
          <DockProvider><MediaViewerProvider><DocViewerProvider>
            <Outlet />
            <CommandPalette open={open} onOpenChange={setOpen} />
            <NotificationProvider />
            <UpdateProvider />
            <ShellModalHost />
          </DocViewerProvider></MediaViewerProvider></DockProvider>
        </NotesProvider></PaneStateProvider></NavigationHistoryProvider></SelectedSessionProvider>
      </ModalRegistryProvider></CurrentProjectProvider>
    </ConnectionStatusProvider></LiveEventsProvider>
  );
}
