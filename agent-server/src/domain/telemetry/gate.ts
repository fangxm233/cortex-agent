import { existsSync } from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from '@core/paths.js';
import { getSettings } from '@core/settings.js';
import { isUpdateDevMode } from '@domain/system/server-update-check.js';
import { resolveTelemetryEndpoint } from './endpoint.js';

export const TELEMETRY_INACTIVE_REASONS = [
  'setting', 'env', 'do-not-track', 'sealed', 'no-endpoint', 'dev',
] as const;
export type TelemetryInactiveReason = (typeof TELEMETRY_INACTIVE_REASONS)[number];

export interface TelemetryGateInput {
  settingEnabled: boolean;
  env: NodeJS.ProcessEnv;
  /** Running from a source checkout (`CORTEX_REPO`, or a tree that still has `src/`). */
  devCheckout: boolean;
  endpoint: string | null;
}

export interface TelemetryGate {
  active: boolean;
  reason: TelemetryInactiveReason | null;
  channel: 'release' | 'dev';
  endpoint: string | null;
}

function truthyFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false' && value !== 'no' && value !== 'off';
}

/** Hard switches that win over the saved setting, in the order they are reported. */
function forcedOffReason(env: NodeJS.ProcessEnv): TelemetryInactiveReason | null {
  if (env.CORTEX_TELEMETRY?.trim() === '0') return 'env';
  if (truthyFlag(env.DO_NOT_TRACK)) return 'do-not-track';
  if (env.CORTEX_CONFIG_IMMUTABLE === '1') return 'sealed';
  return null;
}

/** Pure decision; `telemetryGate()` feeds it the live inputs. */
export function evaluateTelemetryGate(input: TelemetryGateInput): TelemetryGate {
  const explicitOn = input.env.CORTEX_TELEMETRY?.trim() === '1';
  const channel = input.devCheckout ? 'dev' : 'release';
  const off = (reason: TelemetryInactiveReason): TelemetryGate => (
    { active: false, reason, channel, endpoint: input.endpoint }
  );
  const forced = forcedOffReason(input.env);
  if (forced) return off(forced);
  if (!input.settingEnabled) return off('setting');
  if (input.devCheckout && !explicitOn) return off('dev');
  if (!input.endpoint) return off('no-endpoint');
  return { active: true, reason: null, channel, endpoint: input.endpoint };
}

let cachedDevCheckout: boolean | undefined;

/** Fixed for the life of the process; checked once (the gate runs on hot paths). */
function isDevCheckout(): boolean {
  cachedDevCheckout ??= existsSync(path.join(INSTALL_ROOT, 'src', 'entry')) || isUpdateDevMode();
  return cachedDevCheckout;
}

export function telemetryGate(env: NodeJS.ProcessEnv = process.env): TelemetryGate {
  return evaluateTelemetryGate({
    settingEnabled: getSettings().telemetryEnabled,
    env,
    devCheckout: isDevCheckout(),
    endpoint: resolveTelemetryEndpoint(env),
  });
}

export function isTelemetryActive(): boolean {
  return telemetryGate().active;
}
