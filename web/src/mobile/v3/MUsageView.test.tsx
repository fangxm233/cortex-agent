// input:  shared usage view model, mobile Usage view, and local copy
// output: quota, spend, freshness, and refresh feedback regressions
// pos:    Verifies the focused mobile Usage presentation
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SystemUsageStatus } from '@cortex-agent/ui-contract';
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

const copy: MUsageCopy = {
  title: 'Usage', refresh: 'Refresh', refreshing: 'Refreshing…',
  loading: 'Loading usage…', loadError: 'Failed to load usage',
  refreshError: 'Refresh failed', empty: 'No usage data', quota: 'Quota',
  quotaUnsupported: 'Quota unsupported', neverObserved: 'Never observed',
  unavailable: 'Unavailable', gatewaySpend: 'Gateway spend', today: 'Today', month: 'Month',
  observed: 'Observed', ago: 'ago', resetsIn: 'Resets in', resetElapsed: 'Reset elapsed',
  freshness: { live: 'Live', stale: 'Stale', never: 'Never observed', unsupported: 'Unsupported' },
};

function view(overrides: Partial<Parameters<typeof MUsageView>[0]> = {}) {
  return (
    <MUsageView
      view={buildUsageView(status, NOW, 'en')}
      copy={copy}
      isLoading={false}
      queryError={null}
      refreshError={null}
      isRefreshing={false}
      onBack={() => {}}
      onRefresh={() => {}}
      {...overrides}
    />
  );
}

describe('MUsageView provider presentation', () => {
  it('keeps Anthropic/Codex quotas separate from deepseek/qwen spend and unsupported state', () => {
    const html = renderToStaticMarkup(view());

    expect(html).toContain('data-usage-window="five_hour"');
    expect(html).toContain('data-usage-window="codex_primary"');
    expect(html).toContain('data-usage-spend="deepseek"');
    expect(html).toContain('data-usage-spend="qwen-ksu"');
    expect(html.match(/data-usage-quota-state="unsupported"/g)).toHaveLength(2);
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

    create(view({ view: buildUsageView(duplicateResetStatus, NOW, 'en') }));

    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
    consoleError.mockRestore();
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
