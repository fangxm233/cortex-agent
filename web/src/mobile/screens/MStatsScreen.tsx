import { useNavigate } from 'react-router-dom';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useStatsController } from '@/features/stats';
import { mobileHeaderBack } from '@/mobile/mobile-navigation';
import { MStatsView } from './MStatsView';

export function MStatsScreen() {
  const navigate = useNavigate();
  const { setCurrentProject } = useCurrentProject();
  const controller = useStatsController();
  return (
    <MStatsView
      controller={controller}
      onBack={() => mobileHeaderBack(navigate, '/m/settings')}
      onOpenSession={(target) => {
        if (target.projectId) setCurrentProject(target.projectId);
        navigate(`/m/session/${encodeURIComponent(target.sessionId)}`);
      }}
    />
  );
}
