// input:  ProviderUsage fixtures, language, and current epoch
// output: quota filtering, spend, freshness, severity, and timing regressions
// pos:    Verifies the shared usage presentation model
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { SystemUsageStatus } from '@cortex-agent/ui-contract';
import { buildUsageView, formatUsageDuration, utilizationSeverity } from './usage-vm';

const NOW = 1_800_000_000;

const status: SystemUsageStatus = [
  {
    provider: 'anthropic', displayName: 'Anthropic', modes: ['plan'], freshness: 'live',
    observedAt: NOW - 30,
    windows: [
      { type: 'five_hour', utilization: 0.54, resetsAt: NOW + 2 * 3600 },
      { type: 'seven_day', utilization: 0.31, resetsAt: NOW + 3 * 86400 },
      { type: 'model_scoped', label: 'Fable', utilization: 0.1, resetsAt: null },
      { type: 'model_scoped', utilization: 0.2, resetsAt: null },
      { type: 'nimbus_quill', utilization: null, resetsAt: null },
    ],
  },
  {
    provider: 'openai-codex', displayName: 'OpenAI Codex', modes: ['openai-codex'], freshness: 'stale',
    observedAt: NOW - 30 * 60,
    windows: [
      { type: 'codex_primary', utilization: 0.72, resetsAt: NOW + 45 * 60 },
      { type: 'codex_secondary', utilization: 0.19, resetsAt: NOW + 6 * 86400 },
    ],
  },
  {
    provider: 'deepseek', displayName: 'DeepSeek', modes: ['deepseek'], freshness: 'unsupported',
    observedAt: NOW - 120, windows: [], spend: { today: 1.234, month: 12.5 },
  },
  {
    provider: 'qwen-ksu', displayName: 'Qwen KSU', modes: ['qwen-ksu'], freshness: 'unsupported',
    observedAt: null, windows: [], spend: { today: 0, month: 3 },
  },
];

describe('buildUsageView', () => {
  it('keeps provider quotas and gateway spend as separate presentation groups', () => {
    const vm = buildUsageView(status, NOW, 'en');

    expect(vm.providers.map(provider => provider.provider)).toEqual([
      'anthropic', 'openai-codex', 'deepseek', 'qwen-ksu',
    ]);
    expect(vm.providers[0]).toMatchObject({ freshness: 'live', observedAgo: '1m', quotaState: 'available' });
    expect(vm.providers[1]).toMatchObject({ freshness: 'stale', observedAgo: '30m', quotaState: 'available' });
    expect(vm.providers[2]).toMatchObject({
      freshness: 'unsupported', quotaState: 'unsupported',
      spend: { today: '$1.23', month: '$12.50' },
    });
    expect(vm.providers[3]).toMatchObject({
      freshness: 'unsupported', quotaState: 'unsupported',
      spend: { today: '$0.00', month: '$3.00' },
    });
  });

  it('renders known and labeled model windows while dropping unknown experiment buckets', () => {
    const vm = buildUsageView(status, NOW, 'en');

    expect(vm.providers[0].windows.map(window => ({
      type: window.type, label: window.label, utilization: window.utilizationLabel,
      resetIn: window.resetIn,
    }))).toEqual([
      { type: 'five_hour', label: '5 hours', utilization: '54%', resetIn: '2h' },
      { type: 'seven_day', label: '7 days', utilization: '31%', resetIn: '3d' },
      { type: 'model_scoped', label: 'Fable', utilization: '10%', resetIn: null },
    ]);
    expect(vm.providers[1].windows.map(window => window.label)).toEqual(['Primary', 'Secondary']);
  });

  it('marks elapsed reset timestamps instead of describing them as future', () => {
    const vm = buildUsageView([{
      provider: 'anthropic', displayName: 'Anthropic', modes: ['plan'], freshness: 'stale',
      observedAt: NOW - 3600, windows: [
        { type: 'five_hour', utilization: 0.54, resetsAt: NOW - 60 },
      ],
    }], NOW, 'en');

    expect(vm.providers[0].windows[0]).toMatchObject({
      resetsAt: NOW - 60, resetIn: null, resetElapsed: true,
    });
  });

  it('represents a supported push source with no observation as never', () => {
    const vm = buildUsageView([{
      provider: 'openai-codex', displayName: 'OpenAI Codex', modes: ['openai-codex'],
      freshness: 'never', observedAt: null, windows: [], note: 'push-only: waiting for next call',
    }], NOW, 'en');

    expect(vm.providers[0]).toMatchObject({
      freshness: 'never', observedAgo: null, quotaState: 'never',
      note: 'push-only: waiting for next call',
    });
  });

  it('classifies utilization severity at the 70% and 90% thresholds', () => {
    expect(utilizationSeverity(null)).toBe('normal');
    expect(utilizationSeverity(0)).toBe('normal');
    expect(utilizationSeverity(0.699)).toBe('normal');
    expect(utilizationSeverity(0.7)).toBe('warning');
    expect(utilizationSeverity(0.899)).toBe('warning');
    expect(utilizationSeverity(0.9)).toBe('danger');
    expect(utilizationSeverity(1)).toBe('danger');
  });

  it('grades window severity and separates failure notes from informational ones', () => {
    const vm = buildUsageView([
      {
        provider: 'anthropic', displayName: 'Anthropic', modes: ['plan'], freshness: 'live',
        observedAt: NOW,
        windows: [
          { type: 'five_hour', utilization: 0.54, resetsAt: null },
          { type: 'seven_day', utilization: 0.7, resetsAt: null },
          { type: 'model_scoped', label: 'Fable', utilization: 0.93, resetsAt: null },
          { type: 'nimbus_quill', utilization: null, resetsAt: null },
        ],
        note: 'Anthropic usage collection failed: HTTP 429',
      },
      {
        provider: 'openrouter', displayName: 'OpenRouter', modes: ['openrouter'], freshness: 'never',
        observedAt: null, windows: [], note: 'push-only: waiting for next call',
      },
    ], NOW, 'en');

    expect(vm.providers[0].windows.map(window => window.severity)).toEqual([
      'normal', 'warning', 'danger',
    ]);
    expect(vm.providers[0].noteTone).toBe('error');
    expect(vm.providers[1].noteTone).toBe('info');
  });

  it('localizes window labels while keeping compact observed and reset timing', () => {
    const vm = buildUsageView(status.slice(0, 2), NOW, 'zh');

    expect(vm.providers[0].windows.slice(0, 2).map(window => window.label)).toEqual(['5 小时', '7 天']);
    expect(vm.providers[1].windows.map(window => window.label)).toEqual(['主窗口', '次窗口']);
    expect(formatUsageDuration(3 * 86400 + 2 * 3600, 'zh')).toBe('3天 2小时');
  });
});
