import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'vitest';
import { admitCrash, CRASH_DAILY_LIMIT } from '@domain/telemetry/crash-limits.js';
import { buildCrashEvent, captureCrash, describeThrown } from '@domain/telemetry/crash.js';
import { captureChildExitFromEnv, encodeChildExit } from '@domain/telemetry/child-exit.js';
import { takeOutbox } from '@domain/telemetry/outbox.js';
import { CrashEventSchema } from '@domain/telemetry/schema.js';
import { wipeLocalTelemetry } from '@domain/telemetry/service.js';
import { enableTelemetryForTest } from './helpers.js';

let restore: (() => void) | null = null;
afterEach(() => {
  wipeLocalTelemetry();
  restore?.();
  restore = null;
});

function limitsFile(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'telemetry-limits-')), 'crash-limits.json');
}

test('one crash per group per hour; held-back ones ride on the next', () => {
  const file = limitsFile();
  const t0 = Date.parse('2026-10-01T01:00:00Z');
  assert.deepEqual(admitCrash('A', t0, file), { send: true, suppressed: 0 });
  assert.equal(admitCrash('A', t0 + 1_000, file).send, false);
  assert.equal(admitCrash('A', t0 + 2_000, file).send, false);
  assert.equal(admitCrash('B', t0 + 3_000, file).send, true, 'other groups are independent');
  assert.deepEqual(admitCrash('A', t0 + 60 * 60_000, file), { send: true, suppressed: 2 });
});

test('at most twenty crashes per install per day', () => {
  const file = limitsFile();
  const t0 = Date.parse('2026-10-01T01:00:00Z');
  for (let i = 0; i < CRASH_DAILY_LIMIT; i += 1) assert.equal(admitCrash(`G${i}`, t0 + i, file).send, true);
  assert.equal(admitCrash('another', t0 + 100, file).send, false);
  assert.equal(admitCrash('another', Date.parse('2026-10-02T01:00:00Z'), file).send, true, 'the cap resets daily');
});

test('a thrown value becomes a redacted, schema-valid crash event', () => {
  const error = new TypeError(`cannot read ${os.homedir()}/secret.txt`);
  const event = buildCrashEvent({ component: 'server', kind: 'uncaughtException', ...describeThrown(error) });
  assert.ok(CrashEventSchema.safeParse(event).success);
  assert.equal(event.errorName, 'TypeError');
  assert.doesNotMatch(event.message + event.stack, new RegExp(os.homedir()));
  assert.equal(describeThrown('a string').errorName, 'Nonstring');
});

test('captured crashes land in the outbox only while active, rate-limited', () => {
  captureCrash({ component: 'server', kind: 'uncaughtException', errorName: 'E', message: 'm', stack: '' });
  assert.equal(takeOutbox().length, 0, 'inactive: nothing recorded');
  restore = enableTelemetryForTest();
  captureCrash({ component: 'daemon', kind: 'unhandledRejection', errorName: 'E', message: 'm', stack: '' });
  captureCrash({ component: 'daemon', kind: 'unhandledRejection', errorName: 'E', message: 'm', stack: '' });
  assert.equal(takeOutbox().length, 1);
});

test('the daemon-provided child exit is reported once at boot', () => {
  restore = enableTelemetryForTest();
  const env = { CORTEX_CHILD_EXIT: encodeChildExit({ code: null, signal: 'SIGKILL', uptimeMs: 95_000, backoffMs: 2_000 }) };
  captureChildExitFromEnv(env);
  captureChildExitFromEnv({ CORTEX_CHILD_EXIT: 'not json' });
  const [event] = takeOutbox();
  assert.equal(event.type, 'crash');
  const crash = event as Extract<typeof event, { type: 'crash' }>;
  assert.equal(crash.kind, 'childExit');
  assert.equal(crash.groupKey, 'ChildExit@SIGKILL');
  assert.deepEqual(crash.exit, { code: null, signal: 'SIGKILL', backoffMs: 2_000 });
  assert.equal(crash.uptimeS, 95);
});
