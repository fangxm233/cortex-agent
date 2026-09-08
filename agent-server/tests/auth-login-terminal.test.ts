// input:  mocked clack prompts and synthetic terminal-only authorization notices
// output: bilingual terminal text, password masking and abort forwarding regressions
// pos:    Secret-safe login terminal adapter tests without credentials or installers
import { afterEach, expect, it, vi } from 'vitest';
import * as clack from '@clack/prompts';
import { createLoginTerminal } from '../src/entry/auth-login-terminal.js';
import { setLocale, t } from '../src/core/i18n.js';

vi.mock('@clack/prompts', () => ({
  isCancel: (value: unknown) => typeof value === 'symbol',
  password: vi.fn(async () => 'fixture-secret'),
  select: vi.fn(async () => 'fixture'),
  confirm: vi.fn(async () => false),
}));
afterEach(() => { setLocale('en'); vi.clearAllMocks(); });

it('uses password input on stderr and forwards cancellation to clack', async () => {
  const ui = createLoginTerminal();
  const controller = new AbortController();
  vi.mocked(clack.password).mockImplementationOnce(options => new Promise(resolve => {
    options.signal!.addEventListener('abort', () => resolve(Symbol('cancel')), { once: true });
  }));
  const prompt = ui.secret('Fixture prompt', controller.signal);
  controller.abort();
  await expect(prompt).rejects.toMatchObject({ exitCode: 130, message: t('init.auth.cancelled') });
  expect(clack.password).toHaveBeenCalledWith({ message: 'Fixture prompt', output: process.stderr, signal: controller.signal });
});

it.each(['en', 'zh'] as const)('localizes notices and empty selections in %s; auth URLs/codes stay terminal-only', async locale => {
  setLocale(locale);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const ui = createLoginTerminal();
  const url = 'https://example.invalid/fixture-auth';
  const code = 'FIXTURE-CODE';
  ui.notify({ kind: 'auth_url', url });
  ui.notify({ kind: 'device_code', verificationUri: url, userCode: code });
  expect(stderr).toHaveBeenNthCalledWith(1, `${t('init.auth.openBrowser', { url })}\n`);
  expect(stderr).toHaveBeenNthCalledWith(2, `${t('init.auth.deviceCode', { url, code })}\n`);
  expect(stdout).not.toHaveBeenCalled();
  await expect(ui.select('Fixture', [])).rejects.toThrow(t('init.auth.noCapabilities'));
});
