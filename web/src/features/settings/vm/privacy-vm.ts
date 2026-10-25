import type { TelemetryInfo } from '@cortex-agent/ui-contract';
import type { Vocab } from '@/i18n';

type InactiveReason = NonNullable<TelemetryInfo['inactiveReason']>;

// Why the master switch cannot be changed here. `setting` is the switch itself being off.
const LOCKED_REASON: Record<Exclude<InactiveReason, 'setting'>, keyof Vocab> = {
  env: 'tmReasonEnv',
  'do-not-track': 'tmReasonDnt',
  dev: 'tmReasonDev',
  'no-endpoint': 'tmReasonNoEndpoint',
  sealed: 'tmReasonSealed',
};

export interface PrivacyView {
  /** What the switch shows: whether anything is actually sent. */
  on: boolean;
  /** Set when something other than the switch decides; the switch is then read-only. */
  lockedReason: keyof Vocab | null;
  installId: string;
}

function lockedReason(info: TelemetryInfo): keyof Vocab | null {
  const reason = info.inactiveReason;
  if (reason && reason !== 'setting') return LOCKED_REASON[reason];
  // On although the setting is off: CORTEX_TELEMETRY=1 overrides it.
  return info.active && !info.settingEnabled ? 'tmReasonEnv' : null;
}

export function buildPrivacyView(info: TelemetryInfo): PrivacyView {
  return { on: info.active, lockedReason: lockedReason(info), installId: info.installId };
}
