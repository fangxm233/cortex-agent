import { LeftRail } from '@/features/workbench/LeftRail';
import { RightPanel } from '@/features/workbench/RightPanel';
import { MemoryView } from './MemoryView';
import { AppFrame } from '@/shell/AppFrame';
import { WorkspacePanel } from '@/shell/GlassPanel';

// Route /memory — the memory viewer 7b as a center-column view inside the workbench frame. Reuses the
// 1:1 LeftRail + RightPanel; only the center pane swaps to MemoryView, mirroring the prototype's
// `isMemory` state (rails persist — proto-shots 11/12 show the right rail). Frame flex identical to
// WorkbenchPage/OverviewPage: 340px LeftRail / fluid / 400px RightPanel.
export function MemoryPage(): JSX.Element {
  return (
    <AppFrame>
      <LeftRail />
      <WorkspacePanel>
        <MemoryView />
        <RightPanel />
      </WorkspacePanel>
    </AppFrame>
  );
}
