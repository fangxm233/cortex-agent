import { describe, expect, it } from 'vitest';
import { threadScopeFilter } from './scope';

describe('threadScopeFilter', () => {
  it('active → live thread statuses only', () => {
    expect(threadScopeFilter('active')).toEqual(['running', 'waiting']);
  });

  it('history → terminal thread statuses only', () => {
    expect(threadScopeFilter('history')).toEqual(['completed', 'failed', 'cancelled', 'aborted']);
  });

  it('returns a fresh array (mutating the result does not leak into the constant)', () => {
    const first = threadScopeFilter('active');
    first.push('mutated');
    expect(threadScopeFilter('active')).toEqual(['running', 'waiting']);
  });
});
