import { describe, expect, it } from 'vitest';

import { serverUpdateVisible } from './useServerUpdate';

describe('server update visibility', () => {
  it('hides only on idle, or when this version was dismissed', () => {
    expect(serverUpdateVisible({ available: null, state: 'idle' }, null)).toBe(false);
    expect(serverUpdateVisible({ available: '2026.9.20', state: 'prompting' }, null)).toBe(true);
    expect(serverUpdateVisible({ available: '2026.9.20', state: 'prompting' }, '2026.9.20')).toBe(false);
    expect(serverUpdateVisible({ available: '2026.9.21', state: 'prompting' }, '2026.9.20')).toBe(true);
  });
});
