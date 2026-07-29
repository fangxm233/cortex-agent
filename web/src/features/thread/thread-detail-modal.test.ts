// input:  thread detail modal state transitions
// output: open, switch, and close state regressions
// pos:    Guards in-place modal state without router navigation
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { nextThreadDetailModalId } from './ThreadDetailModal';

describe('thread detail modal state', () => {
  it('opens and switches threads in place, then closes', () => {
    expect(nextThreadDetailModalId(null, { type: 'open', threadId: 'thr_a' })).toBe('thr_a');
    expect(nextThreadDetailModalId('thr_a', { type: 'open', threadId: 'thr_b' })).toBe('thr_b');
    expect(nextThreadDetailModalId('thr_b', { type: 'close' })).toBeNull();
  });
});
