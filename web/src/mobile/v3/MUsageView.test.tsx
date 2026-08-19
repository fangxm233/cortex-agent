// input:  shared usage view model, mobile Usage view, copy, and policy callbacks
// output: quota, policy, spend, freshness, refresh, and save-feedback regressions
// pos:    Verifies the focused mobile Usage presentation
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
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
  anthropic: { enabled: true, threshold: 0.82 },
  openrouter: { enabled: false },
};

const copy: MUsageCopy = {
  title: 'Usage', refresh: 'Refresh', refreshing: 'Refreshing…',
  loading: 'Loading usage…', loadError: 'Failed to load usage',
  refreshError: 'Refresh failed', empty: 'No usage data', quota: 'Quota',
  quotaUnsupported: 'Quota unsupported', neverObserved: 'Never observed',
  unavailable: 'Unavailable', gatewaySpend: 'Gateway spend', today: 'Today', month: 'Month',
  observed: 'Observed', ago: 'ago', resetsIn: 'Resets in', resetElapsed: 'Reset elapsed',
  policy: {
    title: 'Usage throttle', enabled: 'Enabled', threshold: 'Custom threshold %',
    save: 'Save', saving: 'Saving…', resetDefault: 'Reset to default',
    defaultHint: 'System default: 90%; 7-day windows: 95%',
    futureHint: 'Changes apply to future observations.',
  },
  freshness: { live: 'Live', stale: 'Stale', never: 'Never observed', unsupported: 'Unsupported' },
};

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

describe('MUsageView provider presentation', () => {
  it('keeps Anthropic/Codex quotas separate from deepseek/qwen spend and hides controls for unsupported providers', () => {
    const html = renderToStaticMarkup(view());

    expect(html).toContain('data-usage-window="five_hour"');
    expect(html).toContain('data-usage-window="codex_primary"');
    expect(html).toContain('data-usage-spend="deepseek"');
    expect(html).toContain('data-usage-spend="qwen-ksu"');
    expect(html).toContain('data-usage-policy="anthropic"');
    expect(html).toContain('data-usage-policy="openai-codex"');
    expect(html).toContain('data-usage-policy="openrouter"');
    expect(html).not.toContain('data-usage-policy="deepseek"');
    expect(html).not.toContain('data-usage-policy="qwen-ksu"');
    expect(html.match(/data-usage-quota-state="unsupported"/g)).toHaveLength(2);
    expect(html).toContain('System default: 90%; 7-day windows: 95%');
    expect(html).toContain('Changes apply to future observations.');
    expect(html).toContain('$1.25');
  });

  it('shows observation freshness and retains stale data when refresh fails', () => {
    const html = renderToStaticMarkup(view({ refreshError: new Error('gateway timeout') }));

    expect(html).toContain('data-usage-freshness="live"');
    expect(html).toContain('data-usage-freshness="stale"');
    expect(html).toContain('data-usage-freshness="never"');
    expect(html).toContain('Observed <time');
    expect(html).toContain('>10m ago</time>');
    expect(html).toContain('Refresh failed: gateway timeout');
    expect(html).toContain('OpenAI Codex');
  });

  it('gives model-scoped windows with a shared reset time distinct React identities', () => {
    const duplicateResetStatus: SystemUsageStatus = [{
      provider: 'anthropic', displayName: 'Anthropic', modes: ['plan'], freshness: 'live',
      observedAt: NOW,
      windows: [
        { type: 'model_scoped', label: 'Fable', utilization: 0.33, resetsAt: null },
        { type: 'model_scoped', label: 'Unlisted Model', utilization: null, resetsAt: null },
      ],
    }];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    create(view({ view: buildUsageView(duplicateResetStatus, policies, NOW, 'en') }));

    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
    consoleError.mockRestore();
  });
});

describe('MUsageView policy controls', () => {
  it('saves custom thresholds, resets defaults, and keeps never-observed providers configurable', () => {
    const onSavePolicy = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(view({ onSavePolicy })); });

    act(() => renderer.root.findByProps({ 'data-usage-threshold-input': 'anthropic' }).props.onChange({ target: { value: '83' } }));
    act(() => renderer.root.findByProps({ 'data-usage-threshold-save': 'anthropic' }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-usage-threshold-reset': 'anthropic' }).props.onClick());
    act(() => renderer.root.findByProps({ 'aria-label': 'Usage throttle openrouter' }).props.onClick());

    expect(onSavePolicy).toHaveBeenNthCalledWith(1, 'anthropic', { enabled: true, thresholdPercent: 83 });
    expect(onSavePolicy).toHaveBeenNthCalledWith(2, 'anthropic', { enabled: true, thresholdPercent: null });
    expect(onSavePolicy).toHaveBeenNthCalledWith(3, 'openrouter', { enabled: true, thresholdPercent: null });
  });

  it('hides policy controls while config is unavailable without hiding quota or spend', () => {
    const renderer = create(view({
      view: buildUsageView(status, null, NOW, 'en'),
      policyControlsState: 'missing',
      isPolicySaving: (provider) => provider === 'anthropic',
      getPolicyError: (provider) => provider === 'openrouter' ? new Error('write failed') : null,
    }));
    const html = JSON.stringify(renderer.toJSON());

    expect(renderer.root.findAllByProps({ 'data-usage-quota': 'anthropic' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-spend': 'deepseek' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-policy': 'anthropic' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-usage-policy': 'openrouter' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Usage throttle anthropic' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-usage-threshold-input': 'anthropic' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-usage-threshold-save': 'anthropic' })).toHaveLength(0);
    expect(html).not.toContain('Saving…');
    expect(html).not.toContain('write failed');
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
    expect(JSON.stringify(renderer.toJSON())).toContain('Refreshing…');
  });

  it('shows a load error only when no server snapshot is available', () => {
    const html = renderToStaticMarkup(view({
      view: { providers: [] },
      queryError: new Error('status unavailable'),
    }));

    expect(html).toContain('Failed to load usage: status unavailable');
    expect(html).not.toContain('No usage data');
  });
});
