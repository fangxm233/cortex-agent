import { LeftRail } from '@/features/workbench/LeftRail';
import { RightPanel } from '@/features/workbench/RightPanel';
import { SkillsView } from './SkillsView';
import { AppFrame } from '@/shell/AppFrame';

// Route /skills — desktop Skills browser (plan §12 A item 2 / 8a). Reuses the 1:1 LeftRail +
// RightPanel; only the center pane renders SkillsView. Frame flex identical to WorkbenchPage /
// OverviewPage / MemoryPage: 340px LeftRail / fluid center / 400px RightPanel.
export function SkillsPage(): JSX.Element {
  return (
    <AppFrame>
      <LeftRail />
      <SkillsView />
      <RightPanel />
    </AppFrame>
  );
}
