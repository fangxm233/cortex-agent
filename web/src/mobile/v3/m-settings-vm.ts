// Pure view-model for the 1l 设置 screen (scheme-mobile.dc.html 1l L601-663). The settings page
// drilled from the project page (1e→1l). Maps the REAL `config.get` ConfigSnapshot + `cost.summary`
// CostSummary into the row slots. No JSX, no tRPC.
//
// 守则11 no-fabrication — every rendered field has a real DTO source or is explicitly omitted:
//   • Daemon host / uptime (scheme `home-server:7433 · uptime 6d 4h`) → NO DTO source (config.get
//     redacts .env, carries no host string and no uptime) → `daemonHost: null` → sub omitted.
//   • Profile default + model → real `profiles.defaultProfile` + the matching entry's `model`.
//   • Budget today/daily → real `cost.today` + `budget.daily_usd` (daily denom from budget.json).
//   • Notify / auto-resume toggles → REAL env-flag PRESENCE (CORTEX_TURN_NOTIFY / CORTEX_AUTO_RESUME)
//     but there is NO config.set for .env → the toggles are READ-ONLY/inert (see view GAP notes).
//   • Platforms → real present env-key groups (slack / feishu); scheme's `（slack, feishu）` is a mock.
//   • Templates count → real `threadTemplates.templates.length` (scheme's `4` is a mock).
//   • App version (scheme `v0.4.2`) → NO DTO source → omitted from the footer (no fabricated version).
import type { ConfigSnapshot, CostSummary } from '@cortex-agent/ui-contract';
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
    budgetSpendLabel: `${fmtMoney(today)} / ${fmtMoney(daily)}`,
    budgetBarPct: budgetBarPct(today, daily),
    notifyOn: isPresent(snapshot.env, NOTIFY_ENV_KEY),
    autoResumeOn: isPresent(snapshot.env, AUTO_RESUME_ENV_KEY),
    platforms,
    templatesCount: snapshot.threadTemplates.templates.length,
  };
}
