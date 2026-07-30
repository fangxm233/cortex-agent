import { describe, expect, it } from 'vitest';
import {
  appUpdateSummaryLine,
  getAppUpdateSnapshot,
  installCtaLabel,
  installDescription,
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

describe('appUpdateSummaryLine', () => {
  it('joins Cortex version · size · 已下载', () => {
    expect(appUpdateSummaryLine(update({ size: 8_808_038 }))).toBe(
      'Cortex 2026.7.30 · 8.4 MB · 已下载',
    );
  });
  it('omits the size segment when unknown', () => {
    expect(appUpdateSummaryLine(update())).toBe('Cortex 2026.7.30 · 已下载');
  });
});

describe('installCtaLabel', () => {
  it('labels each install flow by what actually happens', () => {
    expect(installCtaLabel('appimage')).toBe('重启更新');
    expect(installCtaLabel('nsis')).toBe('运行安装程序');
    expect(installCtaLabel('apk')).toBe('安装');
    expect(installCtaLabel('dmg')).toBe('打开安装包');
    expect(installCtaLabel('deb')).toBe('打开安装包');
    expect(installCtaLabel('rpm')).toBe('打开安装包');
  });
  it('falls back to a generic label for an unknown kind', () => {
    expect(installCtaLabel('flatpak')).toBe('更新');
  });
});

describe('installDescription', () => {
  it('describes every known flow distinctly and non-emptily', () => {
    const kinds = ['appimage', 'nsis', 'apk', 'dmg', 'deb', 'rpm'];
    const texts = kinds.map((k) => installDescription(k));
    for (const t of texts) expect(t.length).toBeGreaterThan(0);
    // The hands-off flows must not promise an automatic restart.
    expect(installDescription('dmg')).not.toBe(installDescription('appimage'));
    expect(installDescription('nsis')).not.toBe(installDescription('appimage'));
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
