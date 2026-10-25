import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import {
  flushTelemetry, recordTelemetryEvent, startTelemetry, stopTelemetry, telemetryTick,
  registerTelemetryHooks, wipeLocalTelemetry,
} from '@domain/telemetry/service.js';
import { OUTBOX_FILE, TELEMETRY_DIR } from '@domain/telemetry/paths.js';
import { readTelemetryState, updateTelemetryState } from '@domain/telemetry/state.js';
import { TelemetryBatchSchema, type HeartbeatEvent } from '@domain/telemetry/schema.js';
import { crashEvent, enableTelemetryForTest, fakeFetch } from './helpers.js';

let restore: (() => void) | null = null;
afterEach(() => {
  stopTelemetry();
  wipeLocalTelemetry();
  restore?.();
  restore = null;
  updateTelemetryState(() => ({ lastHeartbeatAt: null, lastVersion: null, funnelSent: [], pendingUpgrade: null }));
});

function heartbeat(): HeartbeatEvent {
  return {
    type: 'heartbeat', at: new Date().toISOString(), backends: ['claude'], claudeBilling: 'plan',
    piProviders: [], projects: 1, onlineClients: 0, clientPlatforms: {}, activeSessions24h: 0,
    uptimeH: 0.2, settings: { teamEnabled: true },
  };
}

test('queued events upload as one valid batch and leave the outbox empty', async () => {
  restore = enableTelemetryForTest();
  const fetch = fakeFetch();
  startTelemetry({ collectHeartbeat: async () => null, fetchImpl: fetch.impl });
  assert.equal(recordTelemetryEvent(crashEvent()), true);
  assert.equal(recordTelemetryEvent(crashEvent({ message: 'second' })), true);
  await flushTelemetry();
  assert.equal(fetch.requests.length, 1);
  const batch = TelemetryBatchSchema.parse(fetch.requests[0].body);
  assert.equal(batch.events.length, 2);
  assert.equal(batch.envelope.channel, 'dev');
  await flushTelemetry();
  assert.equal(fetch.requests.length, 1);
});

test('a failed upload keeps the events and backs off', async () => {
  restore = enableTelemetryForTest();
  const fetch = fakeFetch([503]);
  startTelemetry({ collectHeartbeat: async () => null, fetchImpl: fetch.impl });
  recordTelemetryEvent(crashEvent());
  await flushTelemetry();
  await flushTelemetry();
  assert.equal(fetch.requests.length, 1, 'second flush waits out the backoff');
});

test('an urgent event uploads within seconds even during the startup delay', async () => {
  restore = enableTelemetryForTest();
  vi.useFakeTimers();
  try {
    const fetch = fakeFetch();
    startTelemetry({ collectHeartbeat: async () => null, fetchImpl: fetch.impl });
    recordTelemetryEvent(crashEvent(), { urgent: true });
    await vi.advanceTimersByTimeAsync(2_500);
    assert.equal(fetch.requests.length, 1);
  } finally {
    vi.useRealTimers();
  }
});

test('the tick sends a heartbeat once per day after the boot delay', async () => {
  restore = enableTelemetryForTest();
  let now = Date.parse('2026-10-01T12:00:00Z');
  const fetch = fakeFetch();
  startTelemetry({ collectHeartbeat: async () => heartbeat(), fetchImpl: fetch.impl, now: () => now, firstDelayMs: 600_000 });
  await telemetryTick();
  assert.equal(fetch.requests.length, 0, 'nothing before the first delay');
  now += 600_000;
  await telemetryTick();
  assert.equal(fetch.requests.length, 1);
  assert.equal(fetch.requests[0].body.events[0].type, 'heartbeat');
  now += 60 * 60_000;
  await telemetryTick();
  assert.equal(fetch.requests.length, 1, 'not again within 24 h');
  assert.ok(readTelemetryState().lastHeartbeatAt);
  now += 24 * 60 * 60_000;
  await telemetryTick();
  assert.equal(fetch.requests.length, 2);
});

test('inactive telemetry records nothing, sends nothing and wipes local files', async () => {
  restore = enableTelemetryForTest();
  const wiped: string[] = [];
  registerTelemetryHooks({ wipe: () => wiped.push('rollups') });
  recordTelemetryEvent(crashEvent());
  assert.equal(existsSync(OUTBOX_FILE), true);
  restore();
  restore = null;
  const fetch = fakeFetch();
  startTelemetry({ collectHeartbeat: async () => heartbeat(), fetchImpl: fetch.impl, firstDelayMs: 0 });
  assert.equal(recordTelemetryEvent(crashEvent()), false);
  await telemetryTick();
  await flushTelemetry();
  assert.equal(fetch.requests.length, 0);
  assert.equal(existsSync(OUTBOX_FILE), false);
  assert.ok(wiped.length > 0);
  assert.deepEqual(readdirSync(TELEMETRY_DIR).filter((name) => name.startsWith('outbox')), []);
});
