import { describe, expect, it } from 'vitest';
import { isStoppable } from './execution-drawer-view';

describe('isStoppable', () => {
  it('only a running execution is stoppable', () => {
    expect(isStoppable('running')).toBe(true);
    for (const s of ['completed', 'failed', 'cancelled', 'stale']) {
      expect(isStoppable(s)).toBe(false);
    }
  });
});
