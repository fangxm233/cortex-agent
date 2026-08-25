// input:  config snapshot, cost summary, settings formatters
// output: mobile settings summaries from canonical config sources
// pos:    Pure data mapping for the mobile settings screen
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type { ConfigSnapshot, ConfigProfileEntry, CostSummary } from '@cortex-agent/ui-contract';
import { fmtMoney } from '@/mobile/ui/format';
import { budgetBarPct } from '@/features/settings/budget-vm';
import { getSetting, hasAnyKey, indexSettings } from '@/features/settings/platform-env';

export interface MSettingsVm {
  daemonHost: string | null;
  profileName: string | null;
  profileModel: string | null;
  profileThinking: string | null;
  profiles: ConfigProfileEntry[];
  budgetSpendLabel: string;
  budgetBarPct: string;
  notifyOn: boolean | null;
  autoResumeOn: boolean | null;
  notifyEnabledCount: number | null;
  platforms: string[];
  templatesCount: number;
  pluginsCount: number | null;
  mcpServers: string[];
  hooks: ConfigSnapshot['hooks'];
}

function booleanSetting(
  snapshot: ConfigSnapshot,
  key: 'turnNotify' | 'autoResume' | 'notifyCompaction',
): boolean | null {
  const value = getSetting(indexSettings(snapshot.settings), key)?.value;
  return typeof value === 'boolean' ? value : null;
}

function configuredPlatforms(snapshot: ConfigSnapshot): string[] {
  const platforms: string[] = [];
  if (hasAnyKey(snapshot.env, 'SLACK_')) platforms.push('slack');
  if (hasAnyKey(snapshot.env, 'FEISHU_')) platforms.push('feishu');
  return platforms;
}

export function buildMSettingsVm(
  snapshot: ConfigSnapshot,
  cost: CostSummary | undefined,
): MSettingsVm {
  const profiles = snapshot.profiles;
  const defaultName = profiles?.defaultProfile ?? null;
  const defaultEntry = defaultName
    ? profiles?.profiles.find((profile) => profile.name === defaultName) ?? null
    : null;
  const daily = snapshot.budget?.daily_usd ?? null;
  const today = cost?.today ?? 0;
  const notifyValues = [
    booleanSetting(snapshot, 'turnNotify'),
    booleanSetting(snapshot, 'autoResume'),
    booleanSetting(snapshot, 'notifyCompaction'),
  ];
  return {
    daemonHost: null,
    profileName: defaultName,
    profileModel: defaultEntry?.model ?? null,
    profileThinking: defaultEntry?.thinking ?? null,
    profiles: profiles?.profiles ?? [],
    budgetSpendLabel: `${fmtMoney(today)} / ${fmtMoney(daily)}`,
    budgetBarPct: budgetBarPct(today, daily),
    notifyOn: notifyValues[0],
    autoResumeOn: notifyValues[1],
    notifyEnabledCount: notifyValues.some((value) => value !== null)
      ? notifyValues.filter((value) => value === true).length : null,
    platforms: configuredPlatforms(snapshot),
    templatesCount: snapshot.threadTemplates.templates.length,
    pluginsCount: null,
    mcpServers: snapshot.mcp?.servers ?? [],
    hooks: snapshot.hooks,
  };
}
