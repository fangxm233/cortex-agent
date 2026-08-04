// input:  ISO completion timestamps and malformed values
// output: Local wall-clock formatting and honest-null tests
// pos:    Unit tests for the shared task timestamp formatter
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { formatTaskTime } from './task-time';

describe('formatTaskTime', () => {
  // Built from local components so the expectation holds in any viewer timezone.
  it('renders a completion instant as local `YYYY-MM-DD HH:mm`', () => {
    const local = new Date(2026, 7, 3, 14, 22, 33);
    expect(formatTaskTime(local.toISOString())).toBe('2026-08-03 14:22');
  });

  it('pads single-digit month, day, hour and minute', () => {
    const local = new Date(2026, 0, 5, 9, 7, 0);
    expect(formatTaskTime(local.toISOString())).toBe('2026-01-05 09:07');
  });

  it('returns null when the timestamp is absent or unparseable', () => {
    expect(formatTaskTime(null)).toBeNull();
    expect(formatTaskTime(undefined)).toBeNull();
    expect(formatTaskTime('')).toBeNull();
    expect(formatTaskTime('not-a-timestamp')).toBeNull();
  });
});
