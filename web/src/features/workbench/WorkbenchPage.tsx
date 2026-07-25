import { PinnedPreviewPane } from '@/features/media/PinnedPreviewPane';
import { usePinnedPreview } from '@/features/media/PinnedPreviewProvider';
import { LeftRail } from './LeftRail';
import { CenterChat } from './CenterChat';
import { RightPanel } from './RightPanel';

// Workbench app-shell frame — 1:1 from prototype.dc.html L39 (Stage-R RB, task f528). The outer
// flex row is the load-bearing seam every workbench pane composes into: 340px LeftRail (flex:none)
// / fluid CenterChat (flex:1;min-width:0) / 400px RightPanel (flex:none). CenterChat + RightPanel
// are Stage-R sibling B/C stubs that render just their pane container so the proportions are exact.
// CurrentProjectProvider (task 569c) holds the cross-pane current-project state written by the
// LeftRail switcher and read by the RightPanel cost bar.
//
// PINNED PREVIEW: the workbench is the dock host for the preview panes (`features/media`). While a
// preview is pinned, `PinnedPreviewPane` renders as a fourth pane and the fluid center region is
// SPLIT between chat and preview — the chat keeps `1 - split` of the grow share (it narrows and
// shifts left), the preview takes `split`. Unpinned, the pane renders nothing (but stays mounted as
// the dock host, which is what makes the modals' ◧ pin button appear on this route only) and the
// chat is fluid exactly as before.
export function WorkbenchPage(): JSX.Element {
  const { active, split } = usePinnedPreview();
  return (
    <div
      style={{
        height: '100vh',
        minHeight: 640,
        minWidth: 1280,
        display: 'flex',
        background: 'var(--proto-card)',
        overflow: 'hidden',
      }}
    >
      <LeftRail />
      <CenterChat grow={active ? 1 - split : 1} />
      <PinnedPreviewPane />
      <RightPanel />
    </div>
  );
}
