import { describe, it, expect } from 'vitest';
import type { ConfigSnapshot, ConfigEnvEntry, CostSummary } from '@cortex-agent/ui-contract';
import { buildMSettingsVm, NOTIFY_ENV_KEY, AUTO_RESUME_ENV_KEY } from './m-settings-vm';

// Neutral placeholder snapshot (守则11 — no real project ids / secrets).
function env(present: string[]): ConfigEnvEntry[] {
  return present.map((key) => ({ key, present: true, masked: '••••••••' }));
}

function snap(over: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return {
    budget: { daily_usd: 10, monthly_usd: 200 },
    profiles: {
      defaultProfile: 'default',
      profiles: [
        { name: 'default', model: 'sonnet-4.5', backend: 'anthropic', mode: null },
        { name: 'fast', model: 'haiku', backend: 'anthropic', mode: null },
      ],
    },
    machines: [],
    mcp: null,
    threadTemplates: { agents: ['a1', 'a2'], templates: ['t1', 't2', 't3', 't4'], shells: ['s1'] },
    hooks: [],
    env: [],
    ...over,
  };
}

function cost(over: Partial<CostSummary> = {}): CostSummary {
  return { today: 4.21, month: 42, dailyBudget: 10, ...over } as CostSummary;
}

describe('buildMSettingsVm', () => {
  it('omits the daemon host (config.get carries no host — never fabricated)', () => {
    expect(buildMSettingsVm(snap(), cost()).daemonHost).toBeNull();
  });

  it('surfaces the real default profile + its model', () => {
    const vm = buildMSettingsVm(snap(), cost());
    expect(vm.profileName).toBe('default');
    expect(vm.profileModel).toBe('sonnet-4.5');
  });

  it('leaves profile null when config.get has no profiles section', () => {
    const vm = buildMSettingsVm(snap({ profiles: null }), cost());
    expect(vm.profileName).toBeNull();
    expect(vm.profileModel).toBeNull();
  });

  it('builds the budget spend label + bar pct from real cost/budget', () => {
    const vm = buildMSettingsVm(snap(), cost({ today: 4.21 }));
    expect(vm.budgetSpendLabel).toBe('$4.21 / $10.00');
    expect(vm.budgetBarPct).toBe('42%');
  });

  it('renders an em dash for the daily denominator when budget.json is absent', () => {
    const vm = buildMSettingsVm(snap({ budget: null }), cost({ today: 0 }));
    expect(vm.budgetSpendLabel).toBe('$0.00 / —');
    expect(vm.budgetBarPct).toBe('0%');
  });

  it('reflects real env presence for the (inert) notify + auto-resume toggles', () => {
    const on = buildMSettingsVm(snap({ env: env([NOTIFY_ENV_KEY, AUTO_RESUME_ENV_KEY]) }), cost());
    expect(on.notifyOn).toBe(true);
    expect(on.autoResumeOn).toBe(true);
    const off = buildMSettingsVm(snap({ env: [] }), cost());
    expect(off.notifyOn).toBe(false);
    expect(off.autoResumeOn).toBe(false);
  });

  it('lists only present platform integrations (real env-key presence)', () => {
    expect(buildMSettingsVm(snap({ env: env(['SLACK_BOT_TOKEN']) }), cost()).platforms).toEqual([
      'slack',
    ]);
    expect(
      buildMSettingsVm(snap({ env: env(['SLACK_BOT_TOKEN', 'FEISHU_APP_ID']) }), cost()).platforms,
    ).toEqual(['slack', 'feishu']);
    expect(buildMSettingsVm(snap({ env: [] }), cost()).platforms).toEqual([]);
  });

  it('counts the real thread templates', () => {
    expect(buildMSettingsVm(snap(), cost()).templatesCount).toBe(4);
  });
});
