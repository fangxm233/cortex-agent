import { LeftRail } from '@/features/workbench/LeftRail';
import { RightPanel } from '@/features/workbench/RightPanel';
import { OverviewView } from './OverviewView';

// Route /overview — the project Overview 6a as a center-column view inside the workbench frame
// (task df67, plan §8.5). Reuses the 1:1 LeftRail (f528) + RightPanel (1e96); only the center pane
// swaps to OverviewView, mirroring the prototype's `isOverview` state (rails persist). Frame flex is
// identical to WorkbenchPage: 340px LeftRail / fluid center / 400px RightPanel.
export function OverviewPage(): JSX.Element {
  return (
    <div
      style={{
        height: '100vh',
        minHeight: 640,
        minWidth: 1280,
        display: 'flex',
        background: '#fff',
        overflow: 'hidden',
      }}
    >
      <LeftRail />
      <OverviewView />
      <RightPanel />
    </div>
  );
}
