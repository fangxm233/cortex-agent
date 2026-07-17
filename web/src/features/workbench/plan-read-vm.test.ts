import { describe, it, expect } from 'vitest';
import { readProgressPct, planStatusLabel, planMetaLine, approveSubLabel } from './plan-read-vm';

// Pure logic for the 6b plan reading page (scheme-mobile sec-6). Neutral fixtures.

describe('readProgressPct', () => {
  it('is 100 when the content does not overflow', () => {
    expect(readProgressPct(0, 800, 700)).toBe(100);
    expect(readProgressPct(0, 800, 800)).toBe(100);
  });
  it('tracks the furthest-seen bottom edge as a percentage, clamped 0..100', () => {
    expect(readProgressPct(0, 400, 1000)).toBe(40);
    expect(readProgressPct(220, 400, 1000)).toBe(62);
    expect(readProgressPct(600, 400, 1000)).toBe(100);
    expect(readProgressPct(9999, 400, 1000)).toBe(100);
  });
});

describe('planStatusLabel', () => {
  it('maps entity status to the short zh/en label (6b header meta `· 待批`)', () => {
    expect(planStatusLabel('pending', 'zh')).toBe('待批');
    expect(planStatusLabel('approved', 'zh')).toBe('已批准');
    expect(planStatusLabel('rejected', 'zh')).toBe('已驳回');
    expect(planStatusLabel('expired', 'zh')).toBe('已过期');
    expect(planStatusLabel('pending', 'en')).toBe('pending');
    expect(planStatusLabel('approved', 'en')).toBe('approved');
  });
});

describe('planMetaLine', () => {
  it('renders `path · N 行 · status`, dropping a missing path', () => {
    expect(planMetaLine('plans/nimbus-plan.md', 128, '待批', 'zh')).toBe('plans/nimbus-plan.md · 128 行 · 待批');
    expect(planMetaLine(null, 12, 'pending', 'en')).toBe('12 lines · pending');
  });
});

describe('approveSubLabel (read-progress gate, 6b main button)', () => {
  it('shows the progress hint below 100%', () => {
    expect(approveSubLabel(62, 'zh')).toBe('已读 62% · 下滑读完或直接批准');
    expect(approveSubLabel(62, 'en')).toBe('read 62% · scroll to finish or approve now');
  });
  it('null at 100% (button reads plain 批准并执行)', () => {
    expect(approveSubLabel(100, 'zh')).toBeNull();
  });
});
