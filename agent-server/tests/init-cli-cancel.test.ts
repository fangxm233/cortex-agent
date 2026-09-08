// input:  CLI dispatcher with an isolated init cancellation stub
// output: bilingual exit-130 regression without stack traces or secret error details
// pos:    Init command cancellation boundary; no configuration or credentials accessed
import { afterEach, expect, it, vi } from 'vitest';
import { runCli } from '../src/entry/cli.js';
import { runInit } from '../src/entry/init.js';
import { LoginCliError } from '../src/entry/auth-login-cli.js';
import { setLocale, t } from '../src/core/i18n.js';

vi.mock('../src/entry/init.js', () => ({
  runInit: vi.fn(),
  getResolvedPaths: vi.fn(),
  formatConfigOutput: vi.fn(),
  parseInitAnswersJson: vi.fn(),
}));
afterEach(() => setLocale('en'));
it.each(['en', 'zh'] as const)('returns clean init cancellation in %s', async locale => {
  setLocale(locale);
  vi.mocked(runInit).mockRejectedValueOnce(new LoginCliError('fixture-private-error', 130));
  const result = await runCli(['init']);
  expect(result).toEqual({ exitCode: 130, stdout: '', stderr: t('init.cancel') });
  expect(JSON.stringify(result)).not.toContain('fixture-private-error');
  expect(result.stderr).not.toContain(' at ');
});
