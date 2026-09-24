// input:  usage controller, navigation, mobile usage view
// output: MUsageScreen
// pos:    Mobile usage screen wiring
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useNavigate } from 'react-router-dom';
import { useUsage } from '@/features/usage';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { MUsageView, type MUsageCopy } from './MUsageView';

const COPY: { en: MUsageCopy; zh: MUsageCopy } = {
  en: {
    title: 'Usage', refresh: 'Refresh', refreshing: 'Refreshing…', loading: 'Loading usage…',
    loadError: 'Failed to load usage', refreshError: 'Refresh failed', empty: 'No usage data',
    quota: 'Quota', neverObserved: 'Never observed',
    unavailable: 'Unavailable', gatewaySpend: 'Gateway spend', today: 'Today', month: 'Month',
    observed: 'Observed', ago: 'ago', resetsIn: 'Resets in', resetElapsed: 'Reset elapsed',
    policy: {
      title: 'Rate-limit threshold', enabled: 'Enabled', disabled: 'Disabled', threshold: 'Threshold',
      save: 'Save', saving: 'Saving…', resetDefault: 'Reset to default',
      throttleAt: 'Throttle at', throttleOff: 'No throttle',
      legacyFallbackTitle: 'Legacy fallback',
      legacyFallbackBody: 'Unset rows inherit the old provider-wide policy until you clear it.',
      clearLegacy: 'Clear legacy fallback',
    },
  },
  zh: {
    title: '用量', refresh: '刷新', refreshing: '刷新中…', loading: '正在加载用量…',
    loadError: '加载用量失败', refreshError: '刷新失败', empty: '暂无用量数据',
    quota: '配额', neverObserved: '尚未观测',
    unavailable: '不可用', gatewaySpend: '网关消费额', today: '今日', month: '本月',
    observed: '观测于', ago: '前', resetsIn: '重置还需', resetElapsed: '重置时间已过',
    policy: {
      title: '限流阈值', enabled: '启用', disabled: '关闭', threshold: '阈值',
      save: '保存', saving: '保存中…', resetDefault: '恢复默认',
      throttleAt: '限流', throttleOff: '不限流',
      legacyFallbackTitle: '旧版兜底',
      legacyFallbackBody: '未单独设置的行会继续继承旧的 provider 级策略，直到你清除它。',
      clearLegacy: '清除旧版兜底',
    },
  },
};

export function MUsageScreen() {
  const navigate = useNavigate();
  const copy = pickCopy(useLang(), COPY);
  const usage = useUsage();
  return (
      <MUsageView
        view={usage.view}
        copy={copy}
        isLoading={usage.isLoading}
        queryError={usage.queryError}
        refreshError={usage.refreshError}
        isRefreshing={usage.isRefreshing}
        policyControlsState={usage.policyControlsState}
        isPolicySaving={usage.isPolicySaving}
        getPolicyError={usage.getPolicyError}
        onBack={() => navigate('/m/settings', { replace: true })}
        onRefresh={usage.refresh}
        onSavePolicy={usage.savePolicy}
      />
  );
}
