import { describe, expect, it } from 'vitest';
import { relativeAge } from './NotificationToaster';

const NOW = Date.parse('2026-07-14T12:00:00.000Z');

describe('relativeAge', () => {
  it('shows "now" for very recent timestamps (< 45s)', () => {
    expect(relativeAge('2026-07-14T11:59:59.000Z', NOW)).toBe('now');
    expect(relativeAge('2026-07-14T11:59:20.000Z', NOW)).toBe('now');
  });

  it('shows minutes under an hour', () => {
    expect(relativeAge('2026-07-14T11:58:00.000Z', NOW)).toBe('2m');
    expect(relativeAge('2026-07-14T11:01:00.000Z', NOW)).toBe('59m');
  });

  it('shows hours under a day', () => {
    expect(relativeAge('2026-07-14T09:00:00.000Z', NOW)).toBe('3h');
  });

  it('shows days beyond 24h', () => {
    expect(relativeAge('2026-07-12T12:00:00.000Z', NOW)).toBe('2d');
  });

  it('never goes negative for a future ts', () => {
    expect(relativeAge('2026-07-14T12:05:00.000Z', NOW)).toBe('now');
  });

  it('falls back to "now" for an unparseable ts', () => {
    expect(relativeAge('not-a-date', NOW)).toBe('now');
  });
});
