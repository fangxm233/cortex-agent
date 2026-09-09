// input:  native reason codes and merged bilingual vocabulary
// output: per-channel status and cached fallback copy regressions
// pos:    Manual update feedback specification
// >>> If updated, update this header and parent CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { en, zh } from '@/i18n/vocab';
import { updateCheckFeedback } from './update-check-feedback';

const skippedReasons = [
  ['no_credentials', 'updateCheckCredentials'],
  ['disabled by CORTEX_APP_UPDATE_DISABLE', 'updateCheckDisabled'],
  ['dev mode (CORTEX_FRONTEND_DIR is set)', 'updateCheckDev'],
  ['dev version 0.0.1', 'updateCheckDev'],
  ['dev_version', 'updateCheckDev'],
  ['version_skipped', 'updateCheckSkippedVersion'],
  ['no_matching_asset', 'updateCheckNoAsset'],
  ['update_in_progress', 'updateCheckInProgress'],
  ['restart_or_install_pending', 'updateCheckRestartPending'],
  ['not_scheduled', 'updateCheckNotScheduled'],
] as const;

describe.each([en, zh])('localized manual check feedback', (L) => {
  it.each(skippedReasons)('explains %s without claiming a fresh check', (reason, key) => {
    const [ui, shell] = updateCheckFeedback({ ui: { status: 'current' }, shell: { status: 'skipped', reason } }, L);
    expect(ui.description).toBe(L.updateCheckCurrent);
    expect(shell.description).toBe(`${L.updateCheckSkipped} ${L[key]}`);
    expect(shell.tone).toBe('waiting');
  });

  it('does not mistake cached fallbacks or unknown failures for fresh success', () => {
    const result = updateCheckFeedback({
      ui: { status: 'error', reason: 'secret network URL', update: { version: 'old' } },
      shell: { status: 'skipped', reason: 'future_reason', update: { version: 'old', kind: 'nsis' } },
    }, L);
    expect(result[0].description).toBe(`${L.updateCheckError} ${L.updateCheckCached}`);
    expect(result[0].tone).toBe('failed');
    expect(result[1].description).toBe(`${L.updateCheckSkipped} ${L.updateCheckCached}`);
    expect(result[1].tone).toBe('waiting');
  });

  it('describes retained prepared updates as available, not freshly up to date', () => {
    const [ui] = updateCheckFeedback({
      ui: { status: 'available', reason: 'prepared_update_retained', update: { version: 'old' } },
      shell: { status: 'current' },
    }, L);
    expect(ui.description).toBe(L.updateCheckAvailable);
  });
});
