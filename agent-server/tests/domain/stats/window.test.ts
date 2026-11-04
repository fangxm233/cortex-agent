import { beforeAll, describe, expect, it } from 'vitest';
import { bucketIndex, statsPeriod } from '../../../src/domain/stats/window.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeAll(() => { process.env.TZ = 'America/Denver'; });

describe('statsPeriod', () => {
  it('24h is 24 hourly buckets ending at the end of the current hour', () => {
    const now = Date.parse('2026-11-04T05:42:10Z');
    const { window, starts } = statsPeriod('24h', 0, now);
    expect(window).toMatchObject({ bucket: 'hour', end: Date.parse('2026-11-04T06:00:00Z'), page: 0 });
    expect(window.start).toBe(window.end - DAY);
    expect(starts).toHaveLength(24);
    expect(starts[23]).toBe(Date.parse('2026-11-04T05:00:00Z'));
  });

  it('day buckets follow local midnights across the autumn DST change', () => {
    // 2026-11-03 22:42 MST; DST ended 2026-11-01 02:00 local, so Nov 1 is 25 hours long.
    const now = Date.parse('2026-11-04T05:42:00Z');
    const { window, starts } = statsPeriod('7d', 0, now);
    expect(window.end).toBe(Date.parse('2026-11-04T07:00:00Z'));
    expect(window.start).toBe(Date.parse('2026-10-28T06:00:00Z'));
    expect(starts).toHaveLength(7);
    const nov1 = starts.indexOf(Date.parse('2026-11-01T06:00:00Z'));
    expect(starts[nov1 + 1]! - starts[nov1]!).toBe(25 * HOUR);
    expect(bucketIndex({ window, starts }, Date.parse('2026-11-02T06:30:00Z'))).toBe(nov1);
    expect(bucketIndex({ window, starts }, Date.parse('2026-11-02T07:00:00Z'))).toBe(nov1 + 1);
  });

  it('spring-forward day is 23 hours', () => {
    const now = Date.parse('2026-03-10T18:00:00Z');
    const { starts, window } = statsPeriod('7d', 0, now);
    const mar8 = starts.indexOf(Date.parse('2026-03-08T07:00:00Z'));
    expect(mar8).toBeGreaterThanOrEqual(0);
    expect(starts[mar8 + 1]! - starts[mar8]!).toBe(23 * HOUR);
    expect(window.end).toBe(Date.parse('2026-03-11T06:00:00Z'));
  });

  it('page n shifts back n whole periods', () => {
    const now = Date.parse('2026-11-04T05:42:00Z');
    const page0 = statsPeriod('30d', 0, now).window;
    const page1 = statsPeriod('30d', 1, now).window;
    expect(page1.end).toBe(page0.start);
    expect(statsPeriod('24h', 2, now).window.end).toBe(statsPeriod('24h', 0, now).window.end - 2 * DAY);
  });

  it('hasOlder holds while the next page still overlaps the 90-day retention', () => {
    const now = Date.parse('2026-11-04T05:42:00Z');
    expect(statsPeriod('30d', 0, now).window.hasOlder).toBe(true);
    expect(statsPeriod('30d', 2, now).window.hasOlder).toBe(true);
    expect(statsPeriod('30d', 3, now).window.hasOlder).toBe(false);
    expect(statsPeriod('7d', 11, now).window.hasOlder).toBe(true);
    expect(statsPeriod('7d', 12, now).window.hasOlder).toBe(false);
  });

  it('bucketIndex is -1 outside the period', () => {
    const now = Date.parse('2026-11-04T05:42:00Z');
    const period = statsPeriod('24h', 0, now);
    expect(bucketIndex(period, period.window.end)).toBe(-1);
    expect(bucketIndex(period, period.window.start - 1)).toBe(-1);
    expect(bucketIndex(period, period.window.start)).toBe(0);
  });
});
