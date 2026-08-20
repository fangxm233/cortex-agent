// input:  usage-status fixtures, per-window policies, language, and current epoch
// output: quota-row, policy, fallback, severity, and timing regressions
// pos:    Verifies the shared desktop/mobile usage presentation model
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { ProviderRateLimits, SystemUsageStatus } from '@cortex-agent/ui-contract';
import { buildUsageView, utilizationSeverity } from './usage-vm';

const NOW = 1_800_000_000;

const status: SystemUsageStatus = [
  {
    provider: 'anthropic', displayName: 'Anthropic', modes: ['plan'], freshness: 'live',
    observedAt: NOW - 30,
    windows: [
      { type: 'five_hour', utilization: 0.54, resetsAt: NOW + 2 * 3600 },
      { type: 'seven_day', utilization: 0.31, resetsAt: NOW + 3 * 86400 },
      { type: 'seven_day_overage_included', utilization: 0.76, resetsAt: NOW + 4 * 86400 },
      { type: 'model_scoped', label: 'Fable', utilization: 0.1, resetsAt: null },
      { type: 'model_scoped', label: 'Lyric', utilization: 0.2, resetsAt: null },
      { type: 'model_scoped', utilization: 0.3, resetsAt: null },
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

describe('buildUsageView', () => {
  it('attaches per-window policy views, exact defaults, and a legacy fallback notice to rendered rows', () => {
    const vm = buildUsageView(status, policies, NOW, 'en');
    const anthropic = vm.providers[0] as any;
    const codex = vm.providers[1] as any;

    expect(vm.providers.map(provider => provider.provider)).toEqual([
      'anthropic', 'openai-codex', 'deepseek', 'openrouter',
    ]);
    expect(anthropic.legacyFallback).toEqual({
      target: { provider: 'anthropic', windowType: null, windowLabel: null },
      enabled: false,
      thresholdPercent: 82,
    });
    expect(anthropic.windows.map((window: any) => ({
      type: window.type,
      label: window.label,
      threshold: window.policy?.thresholdPercent ?? null,
      defaultThreshold: window.policy?.defaultThresholdPercent ?? null,
      enabled: window.policy?.enabled ?? null,
      fallback: window.policy?.usesLegacyFallback ?? null,
    }))).toEqual([
      { type: 'five_hour', label: '5 hours', threshold: 76, defaultThreshold: 90, enabled: true, fallback: false },
      { type: 'seven_day', label: '7 days', threshold: 95, defaultThreshold: 95, enabled: true, fallback: false },
      { type: 'seven_day_overage_included', label: '7 days (incl. overage)', threshold: 82, defaultThreshold: 95, enabled: false, fallback: true },
      { type: 'model_scoped', label: 'Fable', threshold: 90, defaultThreshold: 90, enabled: false, fallback: false },
      { type: 'model_scoped', label: 'Lyric', threshold: 82, defaultThreshold: 90, enabled: false, fallback: true },
    ]);
    expect(codex.legacyFallback).toBeNull();
    expect(codex.windows.map((window: any) => window.policy?.thresholdPercent)).toEqual([91, 90]);
  });

  it('renders known windows plus labeled model rows while dropping unknown and unlabeled buckets', () => {
    const vm = buildUsageView(status, policies, NOW, 'en');

    expect(vm.providers[0].windows.map(window => ({
      type: window.type, label: window.label, utilization: window.utilizationLabel,
      resetIn: window.resetIn,
    }))).toEqual([
      { type: 'five_hour', label: '5 hours', utilization: '54%', resetIn: '2h' },
      { type: 'seven_day', label: '7 days', utilization: '31%', resetIn: '3d' },
      { type: 'seven_day_overage_included', label: '7 days (incl. overage)', utilization: '76%', resetIn: '4d' },
      { type: 'model_scoped', label: 'Fable', utilization: '10%', resetIn: null },
      { type: 'model_scoped', label: 'Lyric', utilization: '20%', resetIn: null },
    ]);
    expect(vm.providers[1].windows.map(window => window.label)).toEqual(['Primary', 'Secondary']);
  });

  it('marks elapsed reset timestamps instead of describing them as future', () => {
    const vm = buildUsageView([{
      provider: 'anthropic', displayName: 'Anthropic', modes: ['plan'], freshness: 'stale',
      observedAt: NOW - 3600, windows: [
        { type: 'five_hour', utilization: 0.54, resetsAt: NOW - 60 },
      ],
    }], policies, NOW, 'en');

    expect(vm.providers[0].windows[0]).toMatchObject({
      resetsAt: NOW - 60, resetIn: null, resetElapsed: true,
    });
  });

  it('keeps windows configurable only while config is ready', () => {
    const vm = buildUsageView(status.slice(0, 2), null, NOW, 'en');

    expect((vm.providers[0].windows[0] as any).policy).toBeNull();
    expect((vm.providers[0] as any).legacyFallback).toBeNull();
    expect((vm.providers[1].windows[0] as any).policy).toBeNull();
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
    ], policies, NOW, 'en');

    expect(vm.providers[0].windows.map(window => window.severity)).toEqual([
      'normal', 'warning', 'danger',
    ]);
    expect(vm.providers[0].noteTone).toBe('error');
    expect(vm.providers[1].noteTone).toBe('info');
  });

  it('keeps a legacy fallback clearable before a never-observed provider has quota rows', () => {
    const openrouter = status.find((provider) => provider.provider === 'openrouter')!;
    const vm = buildUsageView([openrouter], {
      openrouter: { enabled: false, threshold: 0.8 },
    }, NOW, 'en');

    expect(vm.providers[0].windows).toEqual([]);
    expect(vm.providers[0].legacyFallback).toEqual({
      target: { provider: 'openrouter', windowType: null, windowLabel: null },
      enabled: false,
      thresholdPercent: 80,
    });
  });
});
