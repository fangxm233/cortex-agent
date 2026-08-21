// input:  shared usage view model, mobile Usage view, and row-policy callbacks
// output: row-policy target, config gating, and refresh interaction regressions
// pos:    Verifies functional mobile Usage interactions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderRateLimits, SystemUsageStatus } from '@cortex-agent/ui-contract';
import { buildUsageView } from '@/features/usage';
import { MUsageView, type MUsageCopy } from './MUsageView';

const NOW = 1_800_000_000;
const status: SystemUsageStatus = [
  {
    provider: 'anthropic', displayName: 'Anthropic', modes: ['plan'], freshness: 'live',
    observedAt: NOW - 60,
    windows: [
      { type: 'five_hour', utilization: 0.54, resetsAt: NOW + 3600 },
      { type: 'seven_day', utilization: 0.31, resetsAt: NOW + 86400 },
      { type: 'seven_day_overage_included', utilization: 0.74, resetsAt: NOW + 172800 },
      { type: 'model_scoped', label: 'Fable', utilization: 0.33, resetsAt: null },
      { type: 'model_scoped', label: 'Lyric', utilization: null, resetsAt: null },
    ],
  },
  {
    provider: 'openai-codex', displayName: 'OpenAI Codex', modes: ['openai-codex'],
    freshness: 'stale', observedAt: NOW - 600,
    windows: [
      { type: 'codex_primary', utilization: 0.62, resetsAt: NOW + 7200 },
      { type: 'codex_secondary', utilization: 0.18, resetsAt: NOW + 172800 },
    ],
  },
  {
    provider: 'deepseek', displayName: 'DeepSeek', modes: ['deepseek'], freshness: 'unsupported',
    observedAt: NOW - 120, windows: [], spend: { today: 1.25, month: 9.5 },
  },
  {
    provider: 'qwen-ksu', displayName: 'Qwen KSU', modes: ['qwen-ksu'], freshness: 'unsupported',
    observedAt: null, windows: [], spend: { today: 0, month: 2 },
  },
  {
    provider: 'openrouter', displayName: 'OpenRouter', modes: ['openrouter'], freshness: 'never',
    observedAt: null, windows: [], note: 'push-only: waiting for next call',
  },
];

const policies: ProviderRateLimits = {
  anthropic: {
    enabled: false,
    threshold: 0.82,
    windows: [
      { type: 'five_hour', enabled: true, threshold: 0.76 },
      { type: 'seven_day', enabled: true },
      { type: 'model_scoped', label: 'Fable', enabled: false },
    ],
  },
  'openai-codex': { windows: [{ type: 'codex_primary', enabled: true, threshold: 0.91 }] },
};

const copy: MUsageCopy = {
  title: 'Usage', refresh: 'Refresh', refreshing: 'Refreshing…',
  loading: 'Loading usage…', loadError: 'Failed to load usage',
  refreshError: 'Refresh failed', empty: 'No usage data', quota: 'Quota',
  neverObserved: 'Never observed',
  unavailable: 'Unavailable', gatewaySpend: 'Gateway spend', today: 'Today', month: 'Month',
  observed: 'Observed', ago: 'ago', resetsIn: 'Resets in', resetElapsed: 'Reset elapsed',
  policy: {
    title: 'Rate-limit threshold', enabled: 'Enabled', disabled: 'Disabled', threshold: 'Threshold',
    save: 'Save', saving: 'Saving…', resetDefault: 'Reset to default',
    legacyFallbackTitle: 'Legacy fallback',
    legacyFallbackBody: 'Unset rows inherit the old provider-wide policy until you clear it.',
    clearLegacy: 'Clear legacy fallback',
  },
  freshness: { live: 'Live', stale: 'Stale', never: 'Never observed', unsupported: 'Unsupported' },
};

function targetKey(provider: string, windowType?: string, windowLabel?: string | null): string {
  return [provider, windowType ?? '', windowLabel ?? ''].join('::');
}

function view(overrides: Partial<Parameters<typeof MUsageView>[0]> = {}) {
  return (
    <MUsageView
      view={buildUsageView(status, policies, NOW, 'en')}
      copy={copy}
      isLoading={false}
      queryError={null}
      refreshError={null}
      isRefreshing={false}
      policyControlsState="ready"
      isPolicySaving={() => false}
      getPolicyError={() => null}
      onBack={() => {}}
      onRefresh={() => {}}
      onSavePolicy={() => {}}
      {...overrides}
    />
  );
}

describe('MUsageView policy controls', () => {
  it('saves exact row targets, resets fallback rows to explicit defaults, and clears legacy fallback', () => {
    const onSavePolicy = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(view({ onSavePolicy: onSavePolicy as any })); });

    const fiveHour = targetKey('anthropic', 'five_hour');
    const overage = targetKey('anthropic', 'seven_day_overage_included');
    act(() => renderer.root.findByProps({ 'data-usage-threshold-input': fiveHour }).props.onChange({ target: { value: '83' } }));
    act(() => renderer.root.findByProps({ 'data-usage-threshold-save': fiveHour }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-usage-threshold-reset': overage }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-usage-legacy-clear': 'anthropic' }).props.onClick());

    expect(onSavePolicy).toHaveBeenNthCalledWith(1,
      { provider: 'anthropic', windowType: 'five_hour', windowLabel: null },
      { enabled: true, thresholdPercent: 83 },
    );
    expect(onSavePolicy).toHaveBeenNthCalledWith(2,
      { provider: 'anthropic', windowType: 'seven_day_overage_included', windowLabel: null },
      { enabled: true, thresholdPercent: null },
    );
    expect(onSavePolicy).toHaveBeenNthCalledWith(3,
      { provider: 'anthropic', windowType: null, windowLabel: null },
      { enabled: true, thresholdPercent: null },
    );
  });

  it('hides row policy controls while config is unavailable without hiding quota or spend', () => {
    const renderer = create(view({
      view: buildUsageView(status, null, NOW, 'en'),
      policyControlsState: 'missing',
      isPolicySaving: () => true,
      getPolicyError: () => new Error('write failed'),
    }));

    expect(renderer.root.findAllByProps({ 'data-usage-policy-row': targetKey('anthropic', 'five_hour') })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-usage-legacy-fallback': 'anthropic' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-usage-threshold-input': targetKey('anthropic', 'five_hour') })).toHaveLength(0);
  });
});

describe('MUsageView refresh action', () => {
  it('does not impose a click throttle and renders pending feedback', () => {
    const onRefresh = vi.fn();
    const renderer = create(view({ onRefresh }));
    const button = renderer.root.findByProps({ 'data-usage-refresh': true });

    act(() => button.props.onClick());
    act(() => button.props.onClick());
    expect(onRefresh).toHaveBeenCalledTimes(2);

    act(() => renderer.update(view({ onRefresh, isRefreshing: true })));
    const pending = renderer.root.findByProps({ 'data-usage-refresh': true });
    expect(pending.props.disabled).not.toBe(true);
    act(() => pending.props.onClick());
    act(() => pending.props.onClick());
    expect(onRefresh).toHaveBeenCalledTimes(4);
  });
});
