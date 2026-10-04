import { describe, expect, it } from 'vitest';
import { dayLabel, formatSpan, formatSpanPrecise, relTime, timeAgo, timeUntil } from './time-format';

const now = Date.parse('2026-07-15T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('time-format', () => {
  it('labels a past instant compactly in both languages', () => {
    const cases: Array<[number, string, string]> = [
      [20_000, 'now', '刚刚'],
      [13 * MIN, '13m', '13分钟前'],
      [16 * HOUR, '16h', '16小时前'],
      [DAY + HOUR, '1d', '昨天'],
      [3 * DAY, '3d', '3天前'],
      [15 * DAY, '2w', '2周前'],
    ];
    for (const [ms, en, zh] of cases) {
      expect(relTime(ago(ms), now, 'en')).toBe(en);
      expect(relTime(ago(ms), now, 'zh')).toBe(zh);
    }
    expect(relTime(null, now, 'en')).toBe('');
    expect(relTime('not a date', now, 'zh')).toBe('');
  });

  it('reads as ago / until inside a sentence', () => {
    expect(timeAgo(ago(5 * MIN), now, 'en')).toBe('5m ago');
    expect(timeAgo(ago(5 * MIN), now, 'zh')).toBe('5分钟前');
    expect(timeAgo(ago(1000), now, 'en')).toBe('just now');
    expect(timeUntil(now + 19 * HOUR, now, 'en')).toBe('in 19h');
    expect(timeUntil(now + 19 * HOUR, now, 'zh')).toBe('19小时后');
  });

  it('formats spans coarse and to two units', () => {
    expect(formatSpan(45_000, 'en')).toBe('45s');
    expect(formatSpan(3 * HOUR + 5 * MIN, 'zh')).toBe('3小时');
    expect(formatSpanPrecise(3 * MIN + 20_000, 'en')).toBe('3m 20s');
    expect(formatSpanPrecise(3 * MIN + 20_000, 'zh')).toBe('3分20秒');
    expect(formatSpanPrecise(2 * HOUR + 5 * MIN, 'zh')).toBe('2小时5分');
    expect(formatSpanPrecise(2 * HOUR, 'en')).toBe('2h');
    expect(formatSpanPrecise(2 * DAY + 3 * HOUR + 20 * MIN, 'en')).toBe('2d 3h');
    expect(formatSpanPrecise(2 * DAY + 3 * HOUR, 'zh')).toBe('2天3小时');
  });

  it('names calendar days', () => {
    const today = new Date(2026, 8, 26, 17, 0);
    expect(dayLabel(new Date(2026, 8, 26, 9, 0).getTime(), today, 'zh')).toBe('今天');
    expect(dayLabel(new Date(2026, 8, 25, 9, 0).getTime(), today, 'en')).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 8, 24, 9, 0).getTime(), today, 'en')).toBe('Sep 24');
    expect(dayLabel(new Date(2026, 8, 24, 9, 0).getTime(), today, 'zh')).toBe('9月24日');
  });
});
