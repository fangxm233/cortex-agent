import { describe, expect, it } from 'vitest';
import { parseAppUpdate } from './app-update';

describe('parseAppUpdate', () => {
  it('treats anything but an explicit `silent` as needing the user', () => {
    // An older shell sends no `apply` at all; consenting on its behalf would install without asking.
    expect(parseAppUpdate({ version: 'v', kind: 'apk' })?.apply).toBe('prompt');
    expect(parseAppUpdate({ version: 'v', kind: 'apk', apply: 'nonsense' })?.apply).toBe('prompt');
    expect(parseAppUpdate({ version: 'v', kind: 'apk', apply: 'prompt' })?.apply).toBe('prompt');
    expect(parseAppUpdate({ version: 'v', kind: 'apk', apply: 'silent' })?.apply).toBe('silent');
  });

  it('rejects payloads without a version or kind', () => {
    expect(parseAppUpdate(null)).toBeNull();
    expect(parseAppUpdate('x')).toBeNull();
    expect(parseAppUpdate({})).toBeNull();
    expect(parseAppUpdate({ version: '2026.7.30' })).toBeNull();
    expect(parseAppUpdate({ kind: 'apk' })).toBeNull();
  });

  it('drops malformed optional fields instead of failing', () => {
    const u = parseAppUpdate({ version: 'v', kind: 'apk', size: 'big', notes: 7 });
    expect(u).toEqual({ version: 'v', kind: 'apk', apply: 'prompt' });
  });
});
