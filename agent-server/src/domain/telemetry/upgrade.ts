import { getSettings } from '@core/settings.js';
import { CORTEX_VERSION } from '@core/version.js';
import { redactMessage } from './redact.js';
import type { MigrationFailureEvent, UpgradeEvent } from './schema.js';
import { recordTelemetryEvent } from './service.js';
import { readTelemetryState, updateTelemetryState, type PendingUpgrade } from './state.js';

type InstallRunner = (version: string, done: (error: string | null) => void) => void;
type FailureClass = NonNullable<UpgradeEvent['failure']>['class'];

const FAILURE_PATTERNS: Array<[FailureClass, RegExp]> = [
  ['permission', /\b(EACCES|EPERM)\b|permission denied/i],
  ['disk', /\bENOSPC\b|no space left/i],
  ['timeout', /\bETIMEDOUT\b|timed? ?out|killed by SIG/i],
  ['network', /\b(ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH)\b|network|fetch failed/i],
  ['npm', /npm (ERR|error)|exited with code|could not start/i],
];

export function classifyUpgradeFailure(message: string): FailureClass {
  return FAILURE_PATTERNS.find(([, pattern]) => pattern.test(message))?.[0] ?? 'other';
}

function seconds(fromMs: number, toMs: number): number {
  return Math.max(0, Math.round((toMs - fromMs) / 1000));
}

function upgradeEvent(base: Omit<UpgradeEvent, 'type' | 'at'>, at = new Date()): UpgradeEvent {
  return { type: 'upgrade', at: at.toISOString(), ...base };
}

function onInstallDone(pending: PendingUpgrade, error: string | null): void {
  const durationS = seconds(Date.parse(pending.startedAt), Date.now());
  const { from, to, method } = pending;
  if (error === null) {
    updateTelemetryState((state) => ({ ...state, pendingUpgrade: pending }));
    recordTelemetryEvent(upgradeEvent({ from, to, method, stage: 'installed', durationS, failure: null }));
    return;
  }
  const failure = { class: classifyUpgradeFailure(error), message: redactMessage(error) };
  recordTelemetryEvent(upgradeEvent({ from, to, method, stage: 'failed', durationS, failure }), { urgent: true });
}

/** Wrap the npm installer: report its outcome and leave the upgrade for the next boot to confirm. */
export function trackInstall(run: InstallRunner): InstallRunner {
  return (version, done) => {
    const pending: PendingUpgrade = {
      from: CORTEX_VERSION, to: version, startedAt: new Date().toISOString(),
      method: getSettings().serverAutoUpdate ? 'auto' : 'prompt',
    };
    run(version, (error) => {
      try { onInstallDone(pending, error); } catch { /* telemetry never blocks an update */ }
      done(error);
    });
  };
}

function bootEvent(pending: PendingUpgrade | null, lastVersion: string | null, now: number): UpgradeEvent | null {
  if (pending) {
    const stage = pending.to === CORTEX_VERSION ? 'confirmed' : 'unconfirmed';
    const durationS = seconds(Date.parse(pending.startedAt), now);
    return upgradeEvent({ ...pending, stage, durationS, failure: null }, new Date(now));
  }
  if (!lastVersion || lastVersion === CORTEX_VERSION) return null;
  return upgradeEvent({
    from: lastVersion, to: CORTEX_VERSION, method: 'manual', stage: 'version-changed', durationS: null, failure: null,
  }, new Date(now));
}

/** At boot: confirm a recorded upgrade, or notice an unannounced version change. */
export function confirmUpgradeAtBoot(now = Date.now()): void {
  const state = readTelemetryState();
  const event = bootEvent(state.pendingUpgrade, state.lastVersion, now);
  updateTelemetryState((current) => ({ ...current, pendingUpgrade: null, lastVersion: CORTEX_VERSION }));
  if (event) recordTelemetryEvent(event);
}

function migrationErrorClass(error: unknown): MigrationFailureEvent['errorClass'] {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission';
  if (error instanceof SyntaxError) return 'parse';
  return typeof code === 'string' && code.startsWith('E') ? 'io' : 'other';
}

/** `runMigrations` observer: one event per migration that threw. */
export function recordMigrationFailure(failure: { migration: string; error: unknown }): void {
  const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
  recordTelemetryEvent({
    type: 'migration_failure',
    at: new Date().toISOString(),
    migration: failure.migration.replace(/[^A-Za-z0-9._:/@[\]-]/g, '_').slice(0, 80),
    errorClass: migrationErrorClass(failure.error),
    message: redactMessage(message),
  });
}
