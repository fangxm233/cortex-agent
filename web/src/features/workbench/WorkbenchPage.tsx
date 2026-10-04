import { DockPane } from '@/features/dock/DockPane';
import { useDock } from '@/features/dock/DockProvider';
import { LeftRail } from '@/features/workbench/rail/LeftRail';
import { CenterChat } from '@/features/workbench/chat/CenterChat';
import { NotesSheet } from '@/features/notes/NotesSheet';
import { useSettings } from '@/features/settings/useSettings';
import { AppFrame } from '@/shell/AppFrame';
import { WorkspacePanel } from '@/shell/GlassPanel';

// Workbench app-shell frame. The outer flex row is the seam every workbench pane composes into:
// LeftRail (flex:none) / the WorkspacePanel holding the fluid CenterChat (flex:1;min-width:0) and
// the dock. The notes sheet floats over the workspace rather than taking a column; machines live in
// the top bar. CurrentProjectProvider holds the cross-pane current project written by the LeftRail.
//
// THE DOCK: the workbench is the host for `features/dock`. While the dock is open, `DockPane`
// renders as a fourth pane holding one tab strip of file previews and web pages, and the fluid
// center region is SPLIT between chat and dock — the chat keeps `1 - split` of the grow share (it
// narrows and shifts left), the dock takes `split`. Closed, the pane renders nothing (but stays
// mounted as the dock host, which is what makes the modals' ◧ button appear on this route only)
// and the chat is fluid exactly as before.
export function WorkbenchPage(): JSX.Element {
  const { active, split } = useDock();
  const { open: openSettings } = useSettings();
  return (
    <AppFrame>
      <LeftRail />
      <WorkspacePanel>
        <CenterChat grow={active ? 1 - split : 1} onOpenSettings={openSettings} />
        <DockPane />
        <NotesSheet />
      </WorkspacePanel>
    </AppFrame>
  );
}
