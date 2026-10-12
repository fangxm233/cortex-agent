import { useLocation, useNavigate } from 'react-router-dom';
import { useUsage } from '@/features/usage';
import { MUsageView } from './MUsageView';

// Usage is reachable from its Settings row, the Project header's Usage key and the chat's /usage;
// back returns to whichever opened it.
export interface UsageNavState { from?: 'project' | 'chat' }

export function MUsageScreen() {
  const navigate = useNavigate();
  const from = (useLocation().state as UsageNavState | null)?.from;
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
        reset={usage.reset}
        onBack={() => {
          if (from === 'chat') navigate(-1);
          else navigate(from === 'project' ? '/m/project' : '/m/settings', { replace: true });
        }}
        onRefresh={usage.refresh}
        onSavePolicy={usage.savePolicy}
      />
  );
}
