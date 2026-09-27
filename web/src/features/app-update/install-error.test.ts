import { describe, expect, it } from 'vitest';
import { en, zh } from '@/i18n';
import { installErrorText } from './install-error';

describe('installErrorText', () => {
  it('words shell install codes in the UI language', () => {
    expect(installErrorText('no_update_prepared', zh)).toBe(zh.updateErrNoUpdate);
    expect(installErrorText('update_in_progress', en)).toBe(en.updateCheckInProgress);
    expect(installErrorText('restart_or_install_pending', zh)).toBe(zh.updateCheckRestartPending);
  });

  it('keeps the technical detail after the localized sentence', () => {
    expect(installErrorText('command_failed: hdiutil exited with 1', zh)).toBe('系统工具执行失败 (hdiutil exited with 1)');
    expect(installErrorText('apk_installer_refused: status 3: aborted', en))
      .toBe('The system installer rejected the update (status 3: aborted)');
  });

  it('shows unknown or pre-code messages raw', () => {
    expect(installErrorText('the package installer refused the update (status 3)', zh))
      .toBe('the package installer refused the update (status 3)');
    expect(installErrorText('brand_new_code', zh)).toBe('brand_new_code');
  });
});
