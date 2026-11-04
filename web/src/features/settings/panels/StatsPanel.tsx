import { useNavigate } from 'react-router-dom';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useSelectedSession } from '@/features/session/state/SelectedSessionProvider';
import { useStatsController, type StatsController } from '@/features/stats';
import { SHeaderActions } from '@/features/settings/ui/settings-kit';
import { StatsFilters, StatsSections, type StatsSessionTarget } from './stats/StatsSections';

/** Opening a session from the stats closes the sheet and shows it in the workbench, the same two
 *  writes the rail makes. */
function useOpenSession(onClose: () => void): (target: StatsSessionTarget) => void {
  const navigate = useNavigate();
  const { setCurrentProject } = useCurrentProject();
  const { setSelectedSession } = useSelectedSession();
  return (target) => {
    if (target.projectId) setCurrentProject(target.projectId);
    setSelectedSession(target.sessionId);
    onClose();
    navigate('/workbench');
  };
}

export function StatsPanelView(props: { controller: StatsController; onOpenSession: (target: StatsSessionTarget) => void }) {
  return (
    <>
      <SHeaderActions>
        <div data-stats-header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatsFilters controller={props.controller} variant="desktop" />
        </div>
      </SHeaderActions>
      <StatsSections controller={props.controller} variant="desktop" onOpenSession={props.onOpenSession} />
    </>
  );
}

export function StatsPanel({ onClose }: { onClose: () => void }) {
  const controller = useStatsController();
  const openSession = useOpenSession(onClose);
  return <StatsPanelView controller={controller} onOpenSession={openSession} />;
}
