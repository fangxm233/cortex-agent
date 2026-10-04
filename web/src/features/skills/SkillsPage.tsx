import { LeftRail } from '@/features/workbench/rail/LeftRail';
import { NotesSheet } from '@/features/notes/NotesSheet';
import { SkillsView } from './SkillsView';
import { AppFrame } from '@/shell/AppFrame';
import { WorkspacePanel } from '@/shell/GlassPanel';

// Route /skills — desktop Skills browser. Reuses the LeftRail; only the workspace content renders
// SkillsView. The notes sheet floats over it.
export function SkillsPage(): JSX.Element {
  return (
    <AppFrame>
      <LeftRail />
      <WorkspacePanel>
        <SkillsView />
        <NotesSheet />
      </WorkspacePanel>
    </AppFrame>
  );
}
