import { describe, expect, it } from 'vitest';
import { en, zh } from '@/i18n';
import {
  appUpdateSummaryLine,
  installCtaLabel,
  installDescription,
  parseAppUpdate,
  silentUpdateNotice,
} from './app-update';

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

describe('localized app update helper copy', () => {
  it('uses the caller vocabulary for silent notices and summary lines', () => {
    const update = { version: '2026.9.20', kind: 'apk', apply: 'silent' as const };

    expect(silentUpdateNotice(update, en)).toBe('Cortex 2026.9.20 will update when you exit.');
    expect(silentUpdateNotice(update, zh)).toBe('Cortex 2026.9.20 将在退出时更新。');
    expect(appUpdateSummaryLine(update, en)).toBe('Cortex 2026.9.20 · Downloaded');
    expect(appUpdateSummaryLine(update, zh)).toBe('Cortex 2026.9.20 · 已下载');
  });

  it('keeps installer-specific actions and instructions explicit', () => {
    expect(installCtaLabel('appimage', en)).toBe('Restart to update');
    expect(installDescription('appimage', en)).toBe('The app will restart. Running tasks are unaffected.');

    expect(installCtaLabel('nsis', en)).toBe('Run installer');
    expect(installDescription('nsis', en)).toBe('The app will close. Follow the installer to finish updating.');

    expect(installCtaLabel('apk', zh)).toBe('安装');
    expect(installDescription('apk', zh)).toBe('请按系统提示完成安装。');

    expect(installCtaLabel('dmg', zh)).toBe('打开安装包');
    expect(installDescription('dmg', zh)).toBe('将 Cortex 拖入 Applications 完成更新。');

    expect(installCtaLabel('deb', en)).toBe('Open installer');
    expect(installDescription('rpm', en)).toBe('Reopen the app after installation.');
  });
});
