import { Outlet } from 'react-router-dom';
import { WorkspacePanel } from '@/design/GlassPanel';
import { NotesSheet } from '@/features/notes/NotesSheet';
import { LeftRail } from '@/features/workbench/rail/LeftRail';
import { AppFrame } from './AppFrame';

// The desktop window for /workbench, /overview, /memory and /skills: the left rail and one
// workspace pane whose content is the route's view. It is a layout route, so switching between
// those views keeps the rail mounted — its search, scroll and live subscriptions survive. The
// notes sheet floats over whichever view is showing.
export function DesktopWorkspaceLayout(): JSX.Element {
  return (
    <AppFrame>
      <LeftRail />
      <WorkspacePanel>
        <Outlet />
        <NotesSheet />
      </WorkspacePanel>
    </AppFrame>
  );
}
