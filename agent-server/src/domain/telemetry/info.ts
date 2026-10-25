import { getSettings } from '@core/settings.js';
import { telemetryGate, type TelemetryInactiveReason } from './gate.js';
import { getInstallId } from './install-id.js';

/** What the Privacy settings section shows (`telemetry.info`). */
export interface TelemetryInfo {
  settingEnabled: boolean;
  active: boolean;
  inactiveReason: TelemetryInactiveReason | null;
  installId: string;
}

export function telemetryInfo(): TelemetryInfo {
  const gate = telemetryGate();
  return {
    settingEnabled: getSettings().telemetryEnabled,
    active: gate.active,
    inactiveReason: gate.reason,
    installId: getInstallId(),
  };
}
