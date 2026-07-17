import { LeftRail } from '@/features/workbench/LeftRail';
import { RightPanel } from '@/features/workbench/RightPanel';
import { SkillsView } from './SkillsView';

// Route /skills — desktop Skills browser (plan §12 A item 2 / 8a). Reuses the 1:1 LeftRail +
// RightPanel; only the center pane renders SkillsView. Frame flex identical to WorkbenchPage /
// OverviewPage / MemoryPage: 400px LeftRail / fluid center / 400px RightPanel.
export function SkillsPage(): JSX.Element {
  return (
    <div
      style={{
        height: '100vh',
        minHeight: 640,
        minWidth: 1340,
        display: 'flex',
        background: '#fff',
        overflow: 'hidden',
      }}
    >
      <LeftRail />
      <SkillsView />
      <RightPanel />
    </div>
  );
}
