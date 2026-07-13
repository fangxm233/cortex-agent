import { LeftRail } from './LeftRail';
import { CenterChat } from './CenterChat';
import { RightPanel } from './RightPanel';
import { CurrentProjectProvider } from './CurrentProjectProvider';
import { SelectedSessionProvider } from './SelectedSessionProvider';

// Workbench app-shell frame — 1:1 from prototype.dc.html L39 (Stage-R RB, task f528). The outer
// flex row is the load-bearing seam every workbench pane composes into: 240px LeftRail (flex:none)
// / fluid CenterChat (flex:1;min-width:0) / 400px RightPanel (flex:none). CenterChat + RightPanel
// are Stage-R sibling B/C stubs that render just their pane container so the proportions are exact.
// CurrentProjectProvider (task 569c) holds the cross-pane current-project state written by the
// LeftRail switcher and read by the RightPanel cost bar.
export function WorkbenchPage(): JSX.Element {
  return (
    <CurrentProjectProvider>
      <SelectedSessionProvider>
        <div
          style={{
            height: '100vh',
            minHeight: 640,
            minWidth: 1180,
            display: 'flex',
            background: '#fff',
            overflow: 'hidden',
          }}
        >
          <LeftRail />
          <CenterChat />
          <RightPanel />
        </div>
      </SelectedSessionProvider>
    </CurrentProjectProvider>
  );
}
