import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { CORTEX_VERSION } from '@core/version.js';
import {
  classifyUpgradeFailure, confirmUpgradeAtBoot, recordMigrationFailure, trackInstall,
} from '@domain/telemetry/upgrade.js';
import { takeOutbox } from '@domain/telemetry/outbox.js';
import { readTelemetryState, updateTelemetryState } from '@domain/telemetry/state.js';
import { wipeLocalTelemetry } from '@domain/telemetry/service.js';
import { MigrationFailureEventSchema, UpgradeEventSchema } from '@domain/telemetry/schema.js';
import { enableTelemetryForTest } from './helpers.js';

let restore: () => void = () => {};
afterEach(() => {
  wipeLocalTelemetry();
  restore();
  updateTelemetryState(() => ({ lastHeartbeatAt: null, lastVersion: null, funnelSent: [], pendingUpgrade: null }));
});

function upgrades() {
  return takeOutbox().filter((event) => event.type === 'upgrade') as Array<{ stage: string; from: string; to: string; failure: unknown }>;
}

test('a successful install is reported and confirmed by the next boot on the new version', async () => {
  restore = enableTelemetryForTest();
  const install = trackInstall((_version, done) => done(null));
  await new Promise<void>((resolve) => install(CORTEX_VERSION, () => resolve()));
  assert.equal(readTelemetryState().pendingUpgrade?.to, CORTEX_VERSION);
  confirmUpgradeAtBoot();
  const events = upgrades();
  assert.deepEqual(events.map((event) => event.stage), ['installed', 'confirmed']);
  for (const event of events) assert.ok(UpgradeEventSchema.safeParse(event).success);
  assert.equal(readTelemetryState().pendingUpgrade, null);
});

test('a boot on another version than the installed one is unconfirmed', () => {
  restore = enableTelemetryForTest();
  updateTelemetryState((state) => ({
    ...state, pendingUpgrade: { from: '2026.1.1', to: '2099.1.1', method: 'auto', startedAt: new Date().toISOString() },
  }));
  confirmUpgradeAtBoot();
  assert.deepEqual(upgrades().map((event) => event.stage), ['unconfirmed']);
});

test('a version change with no recorded install is reported as manual, once', () => {
  restore = enableTelemetryForTest();
  updateTelemetryState((state) => ({ ...state, lastVersion: '2026.1.1' }));
  confirmUpgradeAtBoot();
  confirmUpgradeAtBoot();
  const events = upgrades();
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, 'version-changed');
  assert.equal(events[0].from, '2026.1.1');
});

test('a failed install is classified and its message redacted', async () => {
  restore = enableTelemetryForTest();
  const install = trackInstall((_version, done) => done(`npm install -g exited with code 243\nEACCES: permission denied, mkdir '${process.env.HOME}/x'`));
  await new Promise<void>((resolve) => install('2099.1.1', () => resolve()));
  const [event] = upgrades();
  assert.equal(event.stage, 'failed');
  assert.deepEqual((event.failure as { class: string }).class, 'permission');
  assert.doesNotMatch(JSON.stringify(event), new RegExp(String(process.env.HOME)));
  assert.equal(readTelemetryState().pendingUpgrade, null);
});

test('failure classes', () => {
  assert.equal(classifyUpgradeFailure('getaddrinfo ENOTFOUND registry.npmjs.org'), 'network');
  assert.equal(classifyUpgradeFailure('ENOSPC: no space left on device'), 'disk');
  assert.equal(classifyUpgradeFailure('npm install -g killed by SIGTERM'), 'timeout');
  assert.equal(classifyUpgradeFailure('npm install -g exited with code 1'), 'npm');
  assert.equal(classifyUpgradeFailure('weird'), 'other');
});

test('migration failures become events with a class and a redacted message', () => {
  restore = enableTelemetryForTest();
  recordMigrationFailure({ migration: '2026.5.1:config/settings.json', error: new SyntaxError('Unexpected token') });
  const io = Object.assign(new Error(`open ${process.env.HOME}/a`), { code: 'EIO' });
  recordMigrationFailure({ migration: '2026.9.1:sentinel:retire-profiles', error: io });
  const events = takeOutbox();
  assert.equal(events.length, 2);
  for (const event of events) assert.ok(MigrationFailureEventSchema.safeParse(event).success);
  assert.deepEqual(events.map((event) => (event as { errorClass: string }).errorClass), ['parse', 'io']);
});
