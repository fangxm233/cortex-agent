import { Outlet } from 'react-router-dom';
import { CommandPalette } from '@/features/command-palette/CommandPalette';
import { useCommandPalette } from '@/features/command-palette/useCommandPalette';
import { SelectedSessionProvider } from '@/features/session/state/SelectedSessionProvider';
import { NotificationProvider } from '@/features/notifications/NotificationProvider';
import { UpdateProvider } from '@/features/update-prompt/UpdateProvider';
import { DockProvider } from '@/features/dock/DockProvider';
import { NotesProvider } from '@/features/notes/NotesProvider';
import { ShellProviders } from './ShellProviders';
import { PaneStateProvider } from './PaneStateProvider';
import { NavigationHistoryProvider } from './NavigationHistoryProvider';
import { ShellModalHost } from './ShellModals';

// App shell (Stage-R RB, task f528): a pass-through layout. The prototype is a single full-screen
// frame owned by each view — `/workbench` (WorkbenchPage) renders the 240/fluid/400 three-pane
// frame including its own left rail; other routes render full-bleed. The old token-summary nav
// LeftRail was removed (superseded). The global ⌘K command palette (design 6c) and every
// always-available overlay — the execution log drawer, thread detail, Settings, New-schedule,
// approvals, … — stay mounted here so any surface can open them without route navigation. The
// overlays share one registry (ShellProviders' ModalRegistry) and are rendered by ShellModalHost.
//
// Three layers, outside in:
//   DockProvider     desktop-only, and OUTSIDE the shared set because it supplies the dock intake
//                    the two preview viewers read: while the dock is open (the tabbed pane beside
//                    the chat on the workbench) `openMedia`/`openDoc` open a tab in it instead of
//                    raising their modal.
//   ShellProviders   the set both chromes mount — live stream, connection, current project, the
//                    modal registry and the two viewers.
//   the rest         desktop-only state: selected session, navigation history, pane layout, notes.
export function AppShell() {
  const { open, setOpen } = useCommandPalette();
  return (
    <DockProvider>
      <ShellProviders>
        <SelectedSessionProvider><NavigationHistoryProvider><PaneStateProvider><NotesProvider>
          <Outlet />
          <CommandPalette open={open} onOpenChange={setOpen} />
          <NotificationProvider />
          <UpdateProvider />
          <ShellModalHost />
        </NotesProvider></PaneStateProvider></NavigationHistoryProvider></SelectedSessionProvider>
      </ShellProviders>
    </DockProvider>
  );
}
