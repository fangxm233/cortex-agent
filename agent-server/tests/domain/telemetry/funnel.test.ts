import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import type { AuthStatusSnapshot } from '@domain/auth/auth-status.js';
import { settleFunnelBaseline, settleFunnelBaselineAtBoot } from '@domain/telemetry/baseline.js';
import {
  recordFunnelStep, recordProviderAuthed, resetFunnelCacheForTests,
} from '@domain/telemetry/funnel.js';
import { settleOutbox, takeOutbox } from '@domain/telemetry/outbox.js';
import { rollupFile } from '@domain/telemetry/paths.js';
import { configureRollupStore, persistRollup } from '@domain/telemetry/rollup.js';
import { readTelemetryState, updateTelemetryState } from '@domain/telemetry/state.js';
import { wipeLocalTelemetry } from '@domain/telemetry/service.js';
import { countMessage, recordRemoteClientConnected } from '@domain/telemetry/usage.js';
import { enableTelemetryForTest } from './helpers.js';

const EMPTY = { lastHeartbeatAt: null, lastVersion: null, funnelSent: [], pendingUpgrade: null, funnelBaseline: null };
const NOW = Date.parse('2026-10-01T12:00:00Z');
let restore: () => void = () => {};
let dir = '';

beforeEach(() => {
  restore = enableTelemetryForTest();
  dir = mkdtempSync(path.join(os.tmpdir(), 'telemetry-funnel-'));
  configureRollupStore({ dir, now: () => NOW });
  resetFunnelCacheForTests();
  updateTelemetryState(() => ({ ...EMPTY }));
});
afterEach(() => {
  configureRollupStore({});
  wipeLocalTelemetry();
  updateTelemetryState(() => ({ ...EMPTY }));
  restore();
});

function taken(): Array<{ step?: string; detail?: string | null }> {
  const events = takeOutbox();
  settleOutbox([]);
  return events as Array<{ step?: string; detail?: string | null }>;
}

function steps(): Array<string | undefined> {
  return taken().map((event) => event.step);
}

function snapshot(...accounts: Array<{ backend: 'claude' | 'pi'; state: string }>): AuthStatusSnapshot {
  return { generatedAt: '', accounts, piRuntime: null } as unknown as AuthStatusSnapshot;
}

test('a home without a baseline predates the funnel: its first-use steps stay quiet and it is flagged once', () => {
  settleFunnelBaselineAtBoot();
  recordFunnelStep('first_session');
  recordFunnelStep('provider_authed', 'claude');
  resetFunnelCacheForTests();
  settleFunnelBaselineAtBoot();
  assert.deepEqual(steps(), ['existing_install']);
  assert.equal(readTelemetryState().funnelBaseline, 'existing');
});

test('an install whose init was already reported is fresh and keeps its first-use steps', () => {
  recordFunnelStep('server_init_completed');
  taken();
  settleFunnelBaselineAtBoot();
  recordFunnelStep('first_session');
  assert.deepEqual(steps(), ['first_session']);
  assert.equal(readTelemetryState().funnelBaseline, 'fresh');
});

test('init on a new home marks it fresh, and the boot that follows keeps it', () => {
  settleFunnelBaseline({ freshHome: true });
  settleFunnelBaselineAtBoot();
  recordFunnelStep('first_turn_completed');
  assert.deepEqual(steps(), ['first_turn_completed']);
});

test('init records the baseline in the home it creates', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'telemetry-home-')), 'telemetry', 'state.json');
  settleFunnelBaseline({ freshHome: true, file });
  assert.equal(readTelemetryState(file).funnelBaseline, 'fresh');
  assert.equal(readTelemetryState().funnelBaseline, null);
});

test('an existing install settled while telemetry was off is flagged once telemetry is on', () => {
  restore();
  settleFunnelBaselineAtBoot();
  restore = enableTelemetryForTest();
  assert.deepEqual(steps(), []);
  settleFunnelBaselineAtBoot();
  assert.deepEqual(steps(), ['existing_install']);
});

test("this machine's own client is not a remote client", () => {
  settleFunnelBaseline({ freshHome: true });
  recordRemoteClientConnected('workbench', 'workbench');
  assert.deepEqual(steps(), []);
  recordRemoteClientConnected('gpu-box', 'workbench');
  assert.deepEqual(steps(), ['first_remote_client']);
  persistRollup();
  const rollup = JSON.parse(readFileSync(rollupFile('2026-10-01', dir), 'utf8'));
  assert.equal(rollup.features.remote_client_connected, 1);
});

test('a first message from any channel is the first session', () => {
  settleFunnelBaseline({ freshHome: true });
  countMessage('slack');
  countMessage('tui');
  assert.deepEqual(steps(), ['first_session']);
});

test('provider_authed is recorded as soon as a backend has usable credentials', async () => {
  settleFunnelBaseline({ freshHome: true });
  await recordProviderAuthed(async () => snapshot({ backend: 'claude', state: 'logged-out' }));
  assert.deepEqual(steps(), []);
  await recordProviderAuthed(async () => snapshot({ backend: 'claude', state: 'logged-out' }, { backend: 'pi', state: 'logged-in' }));
  const [event] = taken();
  assert.deepEqual([event.step, event.detail], ['provider_authed', 'pi']);
  let asked = false;
  await recordProviderAuthed(async () => { asked = true; return null; });
  assert.equal(asked, false, 'no auth lookups once the step is sent');
});
