import { describe, it, expect } from 'vitest';
import type { ConfigSnapshot, ConfigEnvEntry, CostSummary } from '@cortex-agent/ui-contract';
import { buildMSettingsVm } from './m-settings-vm';

function env(present: string[]): ConfigEnvEntry[] {
  return present.map((key) => ({ key, present: true, masked: '••••••••' }));
}

function snap(over: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return {
    budget: { daily_usd: 10, monthly_usd: 200, projects: {} },
    profiles: {
      defaultProfile: 'default',
      profiles: [
        {
          name: 'default', model: 'sonnet-4.5', backend: 'claude', mode: null, thinking: 'high',
          provider: null, claudeBackend: null, extraOption: {}, extraEnvKeys: [], fallbackCount: 0,
        },
        {
          name: 'fast', model: 'haiku', backend: 'claude', mode: null, thinking: null,
          provider: null, claudeBackend: null, extraOption: {}, extraEnvKeys: [], fallbackCount: 0,
        },
      ],
    },
    machines: [],
    mcp: { servers: ['filesystem'] },
    threadTemplates: { agents: ['a1'], templates: ['t1', 't2'], shells: ['s1'] },
    hooks: [],
    env: [],
    settings: [
      { key: 'turnNotify', value: false, source: 'file' },
      { key: 'autoResume', value: true, source: 'default' },
      { key: 'notifyCompaction', value: true, source: 'default' },
    ],
    ...over,
  };
}

function cost(over: Partial<CostSummary> = {}): CostSummary {
  return { today: 4.21, month: 42, dailyBudget: 10, ...over } as CostSummary;
}

describe('buildMSettingsVm', () => {
  it('reads notification values from effective settings rather than legacy env presence', () => {
    const vm = buildMSettingsVm(snap({ env: env(['CORTEX_TURN_NOTIFY']) }), cost());
    expect(vm.notifyOn).toBe(false);
    expect(vm.autoResumeOn).toBe(true);
    expect(vm.notifyEnabledCount).toBe(2);
  });

  it('uses null for missing runtime settings instead of inventing false', () => {
    const vm = buildMSettingsVm(snap({ settings: [] }), cost());
    expect(vm.notifyOn).toBeNull();
    expect(vm.autoResumeOn).toBeNull();
    expect(vm.notifyEnabledCount).toBeNull();
  });
});
