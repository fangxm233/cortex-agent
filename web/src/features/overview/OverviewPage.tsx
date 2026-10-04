import { LeftRail } from '@/features/workbench/rail/LeftRail';
import { NotesSheet } from '@/features/notes/NotesSheet';
import { OverviewView } from './OverviewView';
import { AppFrame } from '@/shell/AppFrame';
import { WorkspacePanel } from '@/shell/GlassPanel';

// Route /overview — the project Overview as a center-column view inside the workbench frame. Reuses
// the LeftRail; only the workspace content swaps to OverviewView. The notes sheet floats over it.
export function OverviewPage(): JSX.Element {
  return (
    <AppFrame>
      <LeftRail />
      <WorkspacePanel>
        <OverviewView />
        <NotesSheet />
      </WorkspacePanel>
    </AppFrame>
  );
}
