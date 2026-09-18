import { describe, it, expect } from 'vitest';
import {
  defaultScheduleForm,
  buildScheduleAddArgs,
  validateScheduleForm,
  editableScheduleFields,
  computeNextRun,
  profileOptions,
  type ScheduleForm,
} from './schedule-modal-vm';

function form(overrides: Partial<ScheduleForm> = {}): ScheduleForm {
  return { ...defaultScheduleForm('nimbus'), ...overrides };
}

describe('profileOptions', () => {
  it('appends current once when it is not among the real names', () => {
    expect(profileOptions(['default', 'research'], 'claude-haiku')).toEqual([
      'default',
      'research',
      'claude-haiku',
    ]);
  });
  it('no source (undefined names) → only the current value, nothing fabricated', () => {
    expect(profileOptions(undefined, 'claude-haiku')).toEqual(['claude-haiku']);
  });
});

describe('buildScheduleAddArgs', () => {
  it('daily → type + time + message + projectId + profile + fallback, no interval/delay/dayOfWeek', () => {
    const args = buildScheduleAddArgs(form({ type: 'daily', message: '  ping  ', profile: 'claude-haiku' }));
    expect(args.type).toBe('daily');
    expect(args.time).toBe('09:00');
    expect(args.message).toBe('ping');
    expect(args.projectId).toBe('nimbus');
    expect(args.profile).toBe('claude-haiku');
    expect(args.fallback).toBe('fresh');
    expect(args.intervalMs).toBeUndefined();
    expect(args.delay).toBeUndefined();
    expect(args.dayOfWeek).toBeUndefined();
  });
  it('interval → raw intervalMs from value+unit, no time', () => {
    const args = buildScheduleAddArgs(form({ type: 'interval', intervalValue: 15, intervalUnit: 'min', message: 'x' }));
    expect(args.intervalMs).toBe(15 * 60_000);
    expect(args.time).toBeUndefined();
  });
  it('weekly → time + dayOfWeek', () => {
    const args = buildScheduleAddArgs(form({ type: 'weekly', time: '07:30', dayOfWeek: 3, message: 'x' }));
    expect(args.time).toBe('07:30');
    expect(args.dayOfWeek).toBe(3);
  });
  it('once → raw delay ms', () => {
    const args = buildScheduleAddArgs(form({ type: 'once', delayValue: 10, delayUnit: 'min', message: 'x' }));
    expect(args.delay).toBe(10 * 60_000);
  });
  it('current-channel target → omit target (no constructible channel)', () => {
    const args = buildScheduleAddArgs(form({ target: 'current-channel', message: 'x' }));
    expect(args.target).toBeUndefined();
  });
  it('fresh target → {kind:fresh}', () => {
    const args = buildScheduleAddArgs(form({ target: 'fresh', message: 'x' }));
    expect(args.target).toEqual({ kind: 'fresh' });
  });
  it('project target → {kind:project, projectId}', () => {
    const args = buildScheduleAddArgs(form({ target: 'project', projectId: 'nimbus', message: 'x' }));
    expect(args.target).toEqual({ kind: 'project', projectId: 'nimbus' });
  });
  it('omits projectId/profile when absent', () => {
    const args = buildScheduleAddArgs(form({ projectId: null, profile: '', message: 'x' }));
    expect(args.projectId).toBeUndefined();
    expect(args.profile).toBeUndefined();
  });
});

describe('validateScheduleForm', () => {
  it('rejects an empty message', () => {
    expect(validateScheduleForm(form({ message: '   ' })).ok).toBe(false);
  });
  it('interval requires a positive value', () => {
    expect(validateScheduleForm(form({ type: 'interval', intervalValue: 0, message: 'x' })).ok).toBe(false);
    expect(validateScheduleForm(form({ type: 'interval', intervalValue: 5, message: 'x' })).ok).toBe(true);
  });
  it('daily/weekly require a HH:MM time', () => {
    expect(validateScheduleForm(form({ type: 'daily', time: '9:00', message: 'x' })).ok).toBe(false);
    expect(validateScheduleForm(form({ type: 'daily', time: '09:00', message: 'x' })).ok).toBe(true);
  });
  it('weekly requires a dayOfWeek in 0..6', () => {
    expect(validateScheduleForm(form({ type: 'weekly', time: '09:00', dayOfWeek: 7, message: 'x' })).ok).toBe(false);
    expect(validateScheduleForm(form({ type: 'weekly', time: '09:00', dayOfWeek: 6, message: 'x' })).ok).toBe(true);
  });
  it('once creation requires a positive delay, but once editing never validates unavailable timing', () => {
    const once = form({ type: 'once', delayValue: 0, message: 'x' });
    expect(validateScheduleForm(once, 'create').ok).toBe(false);
    expect(validateScheduleForm(once, 'edit').ok).toBe(true);
    expect(validateScheduleForm({ ...once, message: ' ' }, 'edit').ok).toBe(false);
  });
});

describe('editableScheduleFields', () => {
  it('locks fields omitted by schedules.update and hides unavailable once timing', () => {
    expect(editableScheduleFields('edit', 'once')).toMatchObject({
      type: false,
      delay: false,
      target: false,
      fallback: false,
      message: true,
      profile: true,
    });
  });

  it('only enables the timing fields supported by the persisted schedule type', () => {
    expect(editableScheduleFields('edit', 'weekly')).toMatchObject({
      time: true,
      dayOfWeek: true,
      interval: false,
      delay: false,
    });
    expect(editableScheduleFields('edit', 'interval')).toMatchObject({
      time: false,
      dayOfWeek: false,
      interval: true,
      delay: false,
    });
  });
});

describe('computeNextRun', () => {
  it('schedules a future daily time on the same day', () => {
    const now = new Date(2026, 6, 7, 8, 8, 0);
    const next = computeNextRun(form({ type: 'daily', time: '09:00' }), now);
    expect(next.getTime() - now.getTime()).toBe(52 * 60_000);
  });
  it('rolls a passed daily time to tomorrow', () => {
    const now = new Date(2026, 6, 7, 10, 0, 0);
    expect(computeNextRun(form({ type: 'daily', time: '09:00' }), now).getDate()).toBe(8);
  });
  it('adds interval and one-shot delays to now', () => {
    const now = new Date(2026, 6, 7, 8, 0, 0);
    expect(computeNextRun(form({ type: 'interval', intervalValue: 30, intervalUnit: 'min' }), now).getTime() - now.getTime()).toBe(30 * 60_000);
    expect(computeNextRun(form({ type: 'once', delayValue: 2, delayUnit: 'hr' }), now).getTime() - now.getTime()).toBe(2 * 3_600_000);
  });
});

// ── edit mode (design 27b「Edit schedule ↗」/ rail「schedule ↗」) ──

import { formFromSchedule, buildScheduleUpdateArgs } from './schedule-modal-vm';
import type { ScheduleInfo } from '@cortex-agent/ui-contract';

function sched(p: Partial<ScheduleInfo> = {}): ScheduleInfo {
  return {
    id: 'sch1', type: 'daily', message: 'scan arXiv', projectId: 'nimbus', profile: 'claude-haiku',
    nextRun: null, lastRun: null, paused: false, pausedBy: null,
    intervalMs: null, time: '07:30', dayOfWeek: null, target: null, fallback: null,
    ...p,
  };
}

describe('formFromSchedule', () => {
  it('prefills a daily schedule (null target → current-channel, null fallback → fresh)', () => {
    const f = formFromSchedule(sched());
    expect(f.type).toBe('daily');
    expect(f.message).toBe('scan arXiv');
    expect(f.profile).toBe('claude-haiku');
    expect(f.time).toBe('07:30');
    expect(f.projectId).toBe('nimbus');
    expect(f.target).toBe('current-channel');
    expect(f.fallback).toBe('fresh');
  });

  it('decomposes intervalMs into value+unit (whole hours prefer hr)', () => {
    expect(formFromSchedule(sched({ type: 'interval', intervalMs: 1_800_000, time: null }))).toMatchObject({
      intervalValue: 30, intervalUnit: 'min',
    });
    expect(formFromSchedule(sched({ type: 'interval', intervalMs: 7_200_000, time: null }))).toMatchObject({
      intervalValue: 2, intervalUnit: 'hr',
    });
  });

  it('prefills weekly dayOfWeek and maps persisted target/fallback', () => {
    const f = formFromSchedule(sched({
      type: 'weekly', dayOfWeek: 3, target: { kind: 'project', projectId: 'nimbus' }, fallback: 'skip',
    }));
    expect(f.dayOfWeek).toBe(3);
    expect(f.target).toBe('project');
    expect(f.fallback).toBe('skip');
  });

  it('maps a null profile to an empty form value (never fabricates one)', () => {
    expect(formFromSchedule(sched({ profile: null })).profile).toBe('');
  });
});

describe('buildScheduleUpdateArgs', () => {
  it('daily → scheduleId + message/profile/projectId/time only', () => {
    const args = buildScheduleUpdateArgs('sch1', formFromSchedule(sched()));
    expect(args).toEqual({
      scheduleId: 'sch1', message: 'scan arXiv', profile: 'claude-haiku', projectId: 'nimbus', time: '07:30',
    });
  });

  it('interval → intervalMs from value+unit', () => {
    const f = form({ type: 'interval', intervalValue: 45, intervalUnit: 'min', profile: '', projectId: null, message: 'm' });
    expect(buildScheduleUpdateArgs('sch2', f)).toEqual({ scheduleId: 'sch2', message: 'm', intervalMs: 2_700_000 });
  });

  it('weekly → time + dayOfWeek', () => {
    const f = form({ type: 'weekly', time: '10:00', dayOfWeek: 5, profile: '', projectId: null, message: 'm' });
    expect(buildScheduleUpdateArgs('sch3', f)).toEqual({ scheduleId: 'sch3', message: 'm', time: '10:00', dayOfWeek: 5 });
  });

  it('once → no timing patch (runAt is not editable from the web)', () => {
    const f = form({ type: 'once', profile: '', projectId: null, message: 'm' });
    expect(buildScheduleUpdateArgs('sch4', f)).toEqual({ scheduleId: 'sch4', message: 'm' });
  });
});
