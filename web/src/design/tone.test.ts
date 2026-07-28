import { describe, expect, it } from 'vitest';
import { statusTone, type Tone } from './tone';

describe('statusTone', () => {
  it('maps synonymous statuses onto the five tones as designed', () => {
    const cases: Record<string, Tone> = {
      running: 'running',
      waiting: 'waiting',
      completed: 'done',
      done: 'done',
      failed: 'failed',
      aborted: 'failed',
      cancelled: 'cancelled',
      stale: 'cancelled',
      open: 'running',
    };
    for (const [status, tone] of Object.entries(cases)) {
      expect(statusTone(status)).toBe(tone);
    }
  });

  it('is case-insensitive', () => {
    expect(statusTone('RUNNING')).toBe('running');
    expect(statusTone('Completed')).toBe('done');
  });

  it('falls back to cancelled for an unknown status', () => {
    expect(statusTone('bogus')).toBe('cancelled');
    expect(statusTone('')).toBe('cancelled');
  });
});
