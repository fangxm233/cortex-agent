import { describe, expect, it } from 'vitest';
import {
  getAppUpdateSnapshot,
  parseAppUpdate,
  publishAppUpdate,
  subscribeAppUpdate,
  type AppUpdateInfo,
} from './app-update';

const update = (over: Partial<AppUpdateInfo> = {}): AppUpdateInfo => ({
  version: '2026.7.30',
  kind: 'appimage',
  ...over,
});

describe('parseAppUpdate', () => {
  it('accepts a shell event payload', () => {
    const u = parseAppUpdate({
      version: '2026.7.30',
      releaseUrl: 'https://g/r',
      notes: 'n',
      size: 84_000_000,
      kind: 'nsis',
    });
    expect(u).toEqual({
      version: '2026.7.30',
      releaseUrl: 'https://g/r',
      notes: 'n',
      size: 84_000_000,
      kind: 'nsis',
    });
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
    expect(u).toEqual({ version: 'v', kind: 'apk' });
  });
});

describe('app-update store', () => {
  it('publishes to the snapshot and notifies subscribers', () => {
    publishAppUpdate(null);
    let notified = 0;
    const unsub = subscribeAppUpdate(() => { notified += 1; });
    const u = update();
    publishAppUpdate(u);
    expect(getAppUpdateSnapshot()).toEqual(u);
    expect(notified).toBe(1);
    publishAppUpdate(null);
    expect(getAppUpdateSnapshot()).toBeNull();
    expect(notified).toBe(2);
    unsub();
    publishAppUpdate(u);
    expect(notified).toBe(2);
    publishAppUpdate(null); // leave the module store clean for other tests
  });
});
