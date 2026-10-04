import { LeftRail } from '@/features/workbench/rail/LeftRail';
import { NotesSheet } from '@/features/notes/NotesSheet';
import { MemoryView } from './MemoryView';
import { AppFrame } from '@/shell/AppFrame';
import { WorkspacePanel } from '@/shell/GlassPanel';

// Route /memory — the memory viewer as a center-column view inside the workbench frame. Reuses the
// LeftRail; only the workspace content swaps to MemoryView. The notes sheet floats over it.
export function MemoryPage(): JSX.Element {
  return (
    <AppFrame>
      <LeftRail />
      <WorkspacePanel>
        <MemoryView />
        <NotesSheet />
      </WorkspacePanel>
    </AppFrame>
  );
}
