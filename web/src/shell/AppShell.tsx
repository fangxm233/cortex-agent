import { useLayoutEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { CommandPalette } from '@/features/command-palette/CommandPalette';
import { useCommandPalette } from '@/features/command-palette/useCommandPalette';
import { SelectedSessionProvider, useSelectedSession } from '@/features/session/state/SelectedSessionProvider';
import { NotificationMount } from '@/features/notifications/NotificationMount';
import { UpdateMount } from '@/features/update-prompt/UpdateMount';
import { DockProvider, useDock } from '@/features/dock/DockProvider';
import { NotesProvider } from '@/features/notes/NotesProvider';
import { ShellProviders } from './ShellProviders';
import { NavigationHistoryProvider } from './NavigationHistoryProvider';
import { ShellModalHost } from './ShellModals';

// App shell: a pass-through layout. The workspace routes render inside DesktopWorkspaceLayout (top
// bar, left rail, workspace pane); other routes render full-bleed. The global ⌘K command palette
// (design 6c) and every always-available overlay — the execution log drawer, Settings,
// New-schedule, approvals, … — stay mounted here so any surface can open them without route
// navigation. The overlays share one registry (ShellProviders' ModalRegistry) and are rendered by
// ShellModalHost.
//
// Three layers, outside in:
//   DockProvider     desktop-only, and OUTSIDE the shared set because it supplies the dock intake
//                    the two preview viewers read: while the dock is open (the tabbed pane beside
//                    the chat on the workbench) `openMedia`/`openDoc` open a tab in it instead of
//                    raising their modal.
//   ShellProviders   the set both chromes mount — live stream, connection, current project, the
//                    modal registry and the two viewers.
//   the rest         desktop-only state: selected session, navigation history, notes.
//
// The dock sits outside the selected session but shows that session's tabs, so DockFollowsSession
// hands the selection in.
export function AppShell() {
  const { open, setOpen } = useCommandPalette();
  return (
    <DockProvider>
      <ShellProviders>
        <SelectedSessionProvider><NavigationHistoryProvider><NotesProvider>
          <DockFollowsSession />
          <Outlet />
          <CommandPalette open={open} onOpenChange={setOpen} />
          <NotificationMount />
          <UpdateMount />
          <ShellModalHost />
        </NotesProvider></NavigationHistoryProvider></SelectedSessionProvider>
      </ShellProviders>
    </DockProvider>
  );
}

/** A layout effect, so the strip swaps in the same frame as the chat it belongs to. While the
 *  selection is still loading the dock keeps the strip it shows. */
function DockFollowsSession(): null {
  const { selectedSessionId } = useSelectedSession();
  const { setSession } = useDock();
  useLayoutEffect(() => {
    if (selectedSessionId !== null) setSession(selectedSessionId);
  }, [selectedSessionId, setSession]);
  return null;
}
