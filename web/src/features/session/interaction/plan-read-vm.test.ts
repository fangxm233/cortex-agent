import { describe, expect, it } from 'vitest';
import { planMetaLine, planStatusLabel, readProgressPct } from './plan-read-vm';

describe('plan read progress and status', () => {
  it('treats short content as fully read and clamps overflowing progress', () => {
    expect(readProgressPct(0, 600, 500)).toBe(100);
    expect(readProgressPct(-20, 200, 1000)).toBe(18);
    expect(readProgressPct(900, 200, 1000)).toBe(100);
    expect(readProgressPct(0, 200, 1000)).toBe(20);
  });

  it('keeps localized status and metadata labels for the reader chrome', () => {
    expect(planStatusLabel('pending', 'en')).toBe('pending');
    expect(planStatusLabel('approved', 'zh')).toBe('已批准');
    expect(planMetaLine('plans/demo.md', 12, 'pending', 'en')).toBe('plans/demo.md · 12 lines · pending');
    expect(planMetaLine(null, 12, '待批', 'zh')).toBe('12 行 · 待批');
  });
});
