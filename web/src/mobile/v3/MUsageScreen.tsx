// input:  public usage feature hook, language state, and navigation
// output: data-bound mobile Usage settings screen
// pos:    Mobile Usage query, refresh, and routing container
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useNavigate } from 'react-router-dom';
import { useUsage } from '@/features/usage';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { MScreen } from '@/mobile/ui/kit';
import { MUsageView, type MUsageCopy } from './MUsageView';

const COPY: { en: MUsageCopy; zh: MUsageCopy } = {
  en: {
    title: 'Usage', refresh: 'Refresh', refreshing: 'Refreshing…', loading: 'Loading usage…',
    loadError: 'Failed to load usage', refreshError: 'Refresh failed', empty: 'No usage data',
    quota: 'Quota', quotaUnsupported: 'Quota unsupported', neverObserved: 'Never observed',
    unavailable: 'Unavailable', gatewaySpend: 'Gateway spend', today: 'Today', month: 'Month',
    observed: 'Observed', ago: 'ago', resetsIn: 'Resets in', resetElapsed: 'Reset elapsed',
    freshness: { live: 'Live', stale: 'Stale', never: 'Never observed', unsupported: 'Unsupported' },
  },
  zh: {
    title: '用量', refresh: '刷新', refreshing: '刷新中…', loading: '正在加载用量…',
    loadError: '加载用量失败', refreshError: '刷新失败', empty: '暂无用量数据',
    quota: '配额', quotaUnsupported: '不支持配额查询', neverObserved: '尚未观测',
    unavailable: '不可用', gatewaySpend: '网关消费额', today: '今日', month: '本月',
    observed: '观测于', ago: '前', resetsIn: '重置还需', resetElapsed: '重置时间已过',
    freshness: { live: '实时', stale: '陈旧', never: '尚未观测', unsupported: '不支持' },
  },
};

export function MUsageScreen() {
  const navigate = useNavigate();
  const copy = pickCopy(useLang(), COPY);
  const usage = useUsage();
  return (
    <MScreen label="1l-u 用量">
      <MUsageView
        view={usage.view}
        copy={copy}
        isLoading={usage.isLoading}
        queryError={usage.queryError}
        refreshError={usage.refreshError}
        isRefreshing={usage.isRefreshing}
        onBack={() => navigate('/m/settings', { replace: true })}
        onRefresh={usage.refresh}
      />
    </MScreen>
  );
}
