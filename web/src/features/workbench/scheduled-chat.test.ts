// input:  scheduled-chat VM + ScheduleInfo fixtures
// output: cadence-label and next-run-delta regressions
// pos:    Scheduled-session chat context bar specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import type { ScheduleInfo } from '@cortex-agent/ui-contract';
import { cadenceLabel, nextRunDelta } from './scheduled-chat';

function sched(p: Partial<ScheduleInfo> = {}): ScheduleInfo {
  return {
    id: 'sch1', type: 'daily', message: 'scan', projectId: 'proj', profile: null,
    nextRun: null, lastRun: null, paused: false, pausedBy: null,
    intervalMs: null, time: '07:30', dayOfWeek: null, target: null, fallback: null,
    ...p,
  };
}

describe('cadenceLabel', () => {
  it('renders daily/weekly/interval/once cadences from the timing spec', () => {
    expect(cadenceLabel(sched())).toBe('daily 07:30');
    expect(cadenceLabel(sched({ type: 'weekly', dayOfWeek: 1, time: '10:00' }))).toBe('weekly Mon 10:00');
    expect(cadenceLabel(sched({ type: 'interval', intervalMs: 1_800_000, time: null }))).toBe('every 30m');
    expect(cadenceLabel(sched({ type: 'interval', intervalMs: 7_200_000, time: null }))).toBe('every 2h');
    expect(cadenceLabel(sched({ type: 'once', time: null }))).toBe('once');
  });

  it('degrades to the bare type when a legacy record has no timing fields', () => {
    expect(cadenceLabel(sched({ time: null }))).toBe('daily');
    expect(cadenceLabel(sched({ type: 'interval', time: null, intervalMs: null }))).toBe('interval');
  });
});

describe('nextRunDelta', () => {
  const now = Date.parse('2026-07-06T12:00:00.000Z');
  it('humanizes the time until nextRun', () => {
    expect(nextRunDelta('2026-07-07T07:00:00.000Z', now)).toBe('19h');
    expect(nextRunDelta('2026-07-06T12:30:00.000Z', now)).toBe('30m');
  });
  it('null nextRun (paused / legacy) → null, never a fabricated delta', () => {
    expect(nextRunDelta(null, now)).toBe(null);
  });
});
