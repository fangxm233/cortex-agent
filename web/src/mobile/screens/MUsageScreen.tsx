import { useLocation, useNavigate } from 'react-router-dom';
import { useUsage } from '@/features/usage';
import { MUsageView } from './MUsageView';

// Usage is reachable both from its Settings row and from the Project header's Usage key; back
// returns to whichever opened it.
export interface UsageNavState { from?: 'project' }

export function MUsageScreen() {
  const navigate = useNavigate();
  const fromProject = (useLocation().state as UsageNavState | null)?.from === 'project';
  const usage = useUsage();
  return (
      <MUsageView
        view={usage.view}
        isLoading={usage.isLoading}
        queryError={usage.queryError}
        refreshError={usage.refreshError}
        isRefreshing={usage.isRefreshing}
        policyControlsState={usage.policyControlsState}
        isPolicySaving={usage.isPolicySaving}
        getPolicyError={usage.getPolicyError}
        onBack={() => navigate(fromProject ? '/m/project' : '/m/settings', { replace: true })}
        onRefresh={usage.refresh}
        onSavePolicy={usage.savePolicy}
      />
  );
}
