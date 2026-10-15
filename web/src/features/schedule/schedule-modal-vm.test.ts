import { describe, it, expect } from 'vitest';
import {
  defaultScheduleForm,
  buildScheduleAddArgs,
  validateScheduleForm,
  editableScheduleFields,
  computeNextRun,
  scheduleModelOptions,
  scheduleThinkingOptions,
  type ScheduleForm,
} from './schedule-modal-vm';

function form(overrides: Partial<ScheduleForm> = {}): ScheduleForm {
  return { ...defaultScheduleForm('nimbus'), ...overrides };
}

const selection = { backend: 'claude' as const, provider: null, model: 'claude-haiku', thinking: 'high', mode: 'api' };

 describe('scheduleModelOptions', () => {
  it('retains a full current selection without config or catalog', () => {
    expect(scheduleModelOptions(undefined, undefined, selection)).toEqual([
      expect.objectContaining({ selection, favorite: false }),
    ]);
    expect(scheduleModelOptions(undefined, undefined, null)).toEqual([]);
  });
  it('keeps default thinking and the current level available before catalog loads', () => {
    expect(scheduleThinkingOptions(undefined, selection)).toEqual(['', 'high']);
    expect(scheduleThinkingOptions(undefined, null)).toEqual(['']);
  });
});

describe('buildScheduleAddArgs', () => {
  it('daily stores the full selection with no interval/delay/dayOfWeek', () => {
    const args = buildScheduleAddArgs(form({ type: 'daily', message: '  ping  ', selection }));
    expect(args.type).toBe('daily');
    expect(args.time).toBe('09:00');
    expect(args.message).toBe('ping');
    expect(args.projectId).toBe('nimbus');
    expect(args.selection).toEqual(selection);
    expect(args).not.toHaveProperty('fallback');
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
  it('binds the schedule to the form project', () => {
    const args = buildScheduleAddArgs(form({ projectId: 'nimbus', message: 'x' }));
    expect(args.projectId).toBe('nimbus');
    expect(args).not.toHaveProperty('target');
  });
  it('omits projectId/selection when absent', () => {
    const args = buildScheduleAddArgs(form({ projectId: null, selection: null, message: 'x' }));
    expect(args.projectId).toBeUndefined();
    expect(args.selection).toBeUndefined();
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
      message: true,
      selection: true,
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
    id: 'sch1', type: 'daily', message: 'scan arXiv', projectId: 'nimbus', selection,
    nextRun: null, lastRun: null, paused: false, pausedBy: null,
    intervalMs: null, time: '07:30', dayOfWeek: null,
    ...p,
  } as ScheduleInfo;
}

describe('formFromSchedule', () => {
  it('prefills a daily schedule', () => {
    const f = formFromSchedule(sched());
    expect(f.type).toBe('daily');
    expect(f.message).toBe('scan arXiv');
    expect(f.selection).toEqual(selection);
    expect(f.time).toBe('07:30');
    expect(f.projectId).toBe('nimbus');
  });

  it('decomposes intervalMs into value+unit (whole hours prefer hr)', () => {
    expect(formFromSchedule(sched({ type: 'interval', intervalMs: 1_800_000, time: null }))).toMatchObject({
      intervalValue: 30, intervalUnit: 'min',
    });
    expect(formFromSchedule(sched({ type: 'interval', intervalMs: 7_200_000, time: null }))).toMatchObject({
      intervalValue: 2, intervalUnit: 'hr',
    });
  });

  it('prefills weekly dayOfWeek', () => {
    expect(formFromSchedule(sched({ type: 'weekly', dayOfWeek: 3 })).dayOfWeek).toBe(3);
  });

  it('preserves a null selection (never fabricates one)', () => {
    expect(formFromSchedule(sched({ selection: null })).selection).toBeNull();
  });
});

describe('buildScheduleUpdateArgs', () => {
  it('daily → scheduleId + message/selection/projectId/time only', () => {
    const args = buildScheduleUpdateArgs('sch1', formFromSchedule(sched()));
    expect(args).toEqual({
      scheduleId: 'sch1', message: 'scan arXiv', selection, projectId: 'nimbus', time: '07:30',
    });
  });

  it('interval → intervalMs from value+unit', () => {
    const f = form({ type: 'interval', intervalValue: 45, intervalUnit: 'min', selection: null, projectId: null, message: 'm' });
    expect(buildScheduleUpdateArgs('sch2', f)).toEqual({ scheduleId: 'sch2', message: 'm', intervalMs: 2_700_000 });
  });

  it('weekly → time + dayOfWeek', () => {
    const f = form({ type: 'weekly', time: '10:00', dayOfWeek: 5, selection: null, projectId: null, message: 'm' });
    expect(buildScheduleUpdateArgs('sch3', f)).toEqual({ scheduleId: 'sch3', message: 'm', time: '10:00', dayOfWeek: 5 });
  });

  it('once → no timing patch (runAt is not editable from the web)', () => {
    const f = form({ type: 'once', selection: null, projectId: null, message: 'm' });
    expect(buildScheduleUpdateArgs('sch4', f)).toEqual({ scheduleId: 'sch4', message: 'm' });
  });
});
