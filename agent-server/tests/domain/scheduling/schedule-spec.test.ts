import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildScheduleTask, nextFireDelayMs, normalizeSchedulePatch, normalizeScheduleSpec, ScheduleSpecError,
} from '../../../src/domain/scheduling/schedule-spec.js';

function specError(fn: () => unknown): ScheduleSpecError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ScheduleSpecError, `expected ScheduleSpecError, got ${error}`);
    return error;
  }
  assert.fail('expected a ScheduleSpecError');
}

test('normalizeScheduleSpec types each schedule kind from its own fields', () => {
  assert.deepEqual(
    normalizeScheduleSpec({ type: 'interval', interval: '30m', message: ' check GPU \n' }),
    { type: 'interval', intervalMs: 1_800_000, message: 'check GPU', projectId: 'general', profile: null },
  );
  assert.deepEqual(
    normalizeScheduleSpec({ type: 'weekly', dayOfWeek: 'Mon', time: '21:00', message: 'review', projectId: 'p1', profile: 'qa' }),
    { type: 'weekly', dayOfWeek: 1, time: '21:00', message: 'review', projectId: 'p1', profile: 'qa' },
  );
  assert.equal(normalizeScheduleSpec({ type: 'weekly', dayOfWeek: '0', time: '08:00', message: 'm' }).type, 'weekly');
  assert.deepEqual(
    normalizeScheduleSpec({ type: 'once', delay: 90_000, message: 'later', preCheck: ' test -f x ' }),
    { type: 'once', delayMs: 90_000, message: 'later', projectId: 'general', profile: null, preCheck: 'test -f x' },
  );
});

test('normalizeScheduleSpec rejects empty, whitespace and lost-value messages', () => {
  for (const message of ['', '   ', 'null', 'undefined', null, undefined]) {
    assert.equal(specError(() => normalizeScheduleSpec({ type: 'daily', time: '09:00', message })).field, 'message');
  }
});

test('normalizeScheduleSpec names the field that is wrong', () => {
  const cases: Array<[Parameters<typeof normalizeScheduleSpec>[0], string]> = [
    [{ type: 'hourly', message: 'm' }, 'type'],
    [{ type: 'interval', message: 'm' }, 'interval'],
    [{ type: 'interval', interval: '30', message: 'm' }, 'interval'],
    [{ type: 'interval', interval: 0, message: 'm' }, 'interval'],
    [{ type: 'daily', time: '25:00', message: 'm' }, 'time'],
    [{ type: 'daily', time: '9:00', message: 'm' }, 'time'],
    [{ type: 'weekly', dayOfWeek: 'funday', time: '09:00', message: 'm' }, 'dayOfWeek'],
    [{ type: 'weekly', dayOfWeek: 7, time: '09:00', message: 'm' }, 'dayOfWeek'],
    [{ type: 'once', delay: 'soon', message: 'm' }, 'delay'],
  ];
  for (const [input, field] of cases) {
    assert.equal(specError(() => normalizeScheduleSpec(input)).field, field, JSON.stringify(input));
  }
});

test('normalizeSchedulePatch allows only the fields of the schedule type and normalizes values', () => {
  assert.deepEqual(normalizeSchedulePatch('daily', { message: ' new ', time: '10:30' }), { message: 'new', time: '10:30' });
  assert.match(specError(() => normalizeSchedulePatch('daily', { intervalMs: 5000 })).message, /invalid fields for daily: intervalMs/);
  assert.equal(specError(() => normalizeSchedulePatch('daily', {})).field, 'patch');
  assert.equal(specError(() => normalizeSchedulePatch('interval', { message: '  ' })).field, 'message');
  assert.match(specError(() => normalizeSchedulePatch('interval', { dispatchType: 'memory-index-regen' })).message, /built-in job/);
});

test('buildScheduleTask computes the first run from the spec', () => {
  const now = new Date(2026, 9, 5, 10, 0).getTime();
  const interval = buildScheduleTask(normalizeScheduleSpec({ type: 'interval', interval: '1h', message: 'm' }), 'a1', now, 'plan');
  assert.equal(interval.nextRun, now + 3_600_000);
  assert.equal(interval.profile, 'plan');

  const daily = buildScheduleTask(normalizeScheduleSpec({ type: 'daily', time: '09:00', message: 'm' }), 'a2', now, 'plan');
  assert.equal(daily.nextRun, new Date(2026, 9, 6, 9, 0).getTime());

  const once = buildScheduleTask(normalizeScheduleSpec({ type: 'once', delay: '2h', message: 'm' }), 'a3', now, 'plan');
  assert.equal(once.runAt, now + 7_200_000);
  assert.equal(once.nextRun, undefined);
});

test('nextFireDelayMs finds the next weekly occurrence, a week out when today already passed', () => {
  const mondayNoon = new Date(2026, 9, 5, 12, 0).getTime();
  assert.equal(new Date(mondayNoon).getDay(), 1);
  assert.equal(nextFireDelayMs({ type: 'weekly', dayOfWeek: 1, time: '09:00' }, mondayNoon), 7 * 86_400_000 - 3 * 3_600_000);
  assert.equal(nextFireDelayMs({ type: 'weekly', dayOfWeek: 2, time: '12:00' }, mondayNoon), 86_400_000);
});
