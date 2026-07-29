// input:  config snapshot, cost summary, settings formatters
// output: mobile settings view model with mounted hooks
// pos:    Pure data mapping for the mobile settings screen
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type { ConfigSnapshot, ConfigProfileEntry, CostSummary } from '@cortex-agent/ui-contract';
import { fmtMoney } from '@/mobile/ui/format';
import { budgetBarPct } from '@/features/settings/budget-vm';
import { hasAnyKey } from '@/features/settings/platform-env';

export interface MSettingsVm {
  /** Daemon host string — always null (config.get carries no host); the Daemon sub is omitted. */
  daemonHost: string | null;
  /** Real default profile name; null when config.get has no profiles section. */
  profileName: string | null;
  /** Real model of the default profile; null when unknown. */
  profileModel: string | null;
  /** Real thinking level of the default profile (claude --effort / pi --thinking); null when none. */
  profileThinking: string | null;
  /** All configured profiles (for the profile-switch bottom sheet). */
  profiles: ConfigProfileEntry[];
  /** `$today / $daily` spend label (real cost.today over budget.daily_usd). */
  budgetSpendLabel: string;
  /** Clamped `NN%` fill for the spend bar. */
  budgetBarPct: string;
  /** REAL env presence of CORTEX_TURN_NOTIFY (inert — no config.set for .env). */
  notifyOn: boolean;
  /** REAL env presence of CORTEX_AUTO_RESUME (inert — no config.set for .env). */
  autoResumeOn: boolean;
  /** Present platform integrations among slack / feishu (real env-key presence). */
  platforms: string[];
  /** Real count of thread templates (threadTemplates.templates). */
  templatesCount: number;
  /** Mounted registry and template-scoped hook state. */
  hooks: ConfigSnapshot['hooks'];
}

/** The env flags whose PRESENCE the two toggles reflect (both inert — no .env write path). */
export const NOTIFY_ENV_KEY = 'CORTEX_TURN_NOTIFY';
export const AUTO_RESUME_ENV_KEY = 'CORTEX_AUTO_RESUME';

function isPresent(env: ConfigSnapshot['env'], key: string): boolean {
  return env.some((e) => e.key === key && e.present);
}

/** Map the real config.get snapshot + cost.summary into the 1l screen view-model. */
export function buildMSettingsVm(
  snapshot: ConfigSnapshot,
  cost: CostSummary | undefined,
): MSettingsVm {
  const profiles = snapshot.profiles;
  const defaultName = profiles?.defaultProfile ?? null;
  const defaultEntry = defaultName
    ? profiles?.profiles.find((p) => p.name === defaultName) ?? null
    : null;

  const daily = snapshot.budget?.daily_usd ?? null;
  const today = cost?.today ?? 0;

  const platforms: string[] = [];
  if (hasAnyKey(snapshot.env, 'SLACK_')) platforms.push('slack');
  if (hasAnyKey(snapshot.env, 'FEISHU_')) platforms.push('feishu');

  return {
    daemonHost: null,
    profileName: defaultName,
    profileModel: defaultEntry?.model ?? null,
    profileThinking: defaultEntry?.thinking ?? null,
    profiles: profiles?.profiles ?? [],
    budgetSpendLabel: `${fmtMoney(today)} / ${fmtMoney(daily)}`,
    budgetBarPct: budgetBarPct(today, daily),
    notifyOn: isPresent(snapshot.env, NOTIFY_ENV_KEY),
    autoResumeOn: isPresent(snapshot.env, AUTO_RESUME_ENV_KEY),
    platforms,
    templatesCount: snapshot.threadTemplates.templates.length,
    hooks: snapshot.hooks,
  };
}
