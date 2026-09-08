// input:  init auth coordinator, fake login terminal and snapshots
// output: bilingual onboarding, clean cancellation and isolated installer boundary tests
// pos:    Provider onboarding tests without real credentials
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { afterEach, it, expect, vi } from 'vitest';
import { setLocale, t } from '../src/core/i18n.js';
import { onboardInitAuth, usableBackends } from '../src/entry/init-auth.js';
import { ensureClaudeForLogin } from '../src/entry/auth-login-terminal.js';
import { LoginCliError, runAuthLoginCli, type LoginCliDeps } from '../src/entry/auth-login-cli.js';
import { createAuthLoginService } from '../src/domain/auth/login-service.js';
import type { AuthStatusSnapshot } from '../src/domain/auth/auth-status.js';
const snapshot = { accounts: [{ backend: 'pi', provider: 'fixture', label: 'Fixture', capabilities: ['api_key'], state: 'logged-in', credentials: [] }], piRuntime: { available: true } } as AuthStatusSnapshot;
function dependencies(): LoginCliDeps {
  return { tty: true, readStatus: vi.fn(async () => snapshot), ui: { select: vi.fn(async () => 'continue'), secret: vi.fn(async () => 'test-only-secret'), confirm: vi.fn(async () => false), notify: vi.fn() }, service: {} as LoginCliDeps['service'], ensureClaude: vi.fn(async () => true), sync: vi.fn(async () => ({ configured: false, endpoints: 0, profiles: [], reason: 'no-endpoints' })) };
}
afterEach(() => setLocale('en'));
it.each(['en', 'zh'] as const)('localizes init choices and installation confirmation in %s', async locale => {
  setLocale(locale);
  const d = dependencies();
  const emit = vi.fn();
  await onboardInitAuth(true, emit, d);
  expect(d.ui.select).toHaveBeenCalledWith(t('init.auth.setup'), [
    { value: 'continue', label: t('init.auth.continue') },
    { value: 'login', label: t('init.auth.login') },
    { value: 'rescan', label: t('init.auth.rescan') },
    { value: 'skip', label: t('init.auth.skip') },
  ]);
  expect(d.ui.notify).toHaveBeenCalledWith({ kind: 'info', message: `pi / Fixture: ${t('cmd.auth.state.logged-in')}` });
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ state: 'configured', accounts: [{ backend: 'pi', provider: 'fixture', state: 'logged-in' }] }));
  const installer = { installed: () => false, install: vi.fn() };
  await ensureClaudeForLogin(d.ui, installer);
  expect(d.ui.confirm).toHaveBeenCalledWith(t('init.auth.installPrompt'));
  expect(installer.install).not.toHaveBeenCalled();
});
it('propagates setup menu cancellation without rescan or success', async () => {
  const d = dependencies();
  d.ui.select = vi.fn(async () => { throw new LoginCliError(t('init.auth.cancelled'), 130); });
  await expect(onboardInitAuth(true, vi.fn(), d)).rejects.toMatchObject({ exitCode: 130 });
  expect(d.readStatus).toHaveBeenCalledTimes(1);
});
it('stops the init loop when nested login is cancelled', async () => {
  const d = dependencies();
  d.ui.select = vi.fn().mockResolvedValueOnce('login').mockRejectedValueOnce(new LoginCliError(t('init.auth.cancelled'), 130));
  await expect(onboardInitAuth(true, vi.fn(), d)).rejects.toMatchObject({ exitCode: 130, message: t('init.cancel') });
  expect(d.ui.select).toHaveBeenCalledTimes(2);
  expect(d.readStatus).toHaveBeenCalledTimes(1);
  expect(d.ui.notify).not.toHaveBeenCalledWith(expect.objectContaining({ message: t('init.auth.saved') }));
});
it('noninteractive init emits credential state without login, sync or prompts', async () => {
  const d = dependencies(); const emit = vi.fn();
  expect(await onboardInitAuth(false, emit, d)).toEqual(['pi']);
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ step: 'auth', state: 'configured', inferenceVerified: false }));
  expect(d.ui.select).not.toHaveBeenCalled(); expect(d.sync).not.toHaveBeenCalled();
});
it('detection exceptions remain unknown, not successful or logged out', async () => {
  const d = dependencies(); d.readStatus = vi.fn(async () => { throw new Error('private'); }); const emit = vi.fn();
  expect(await onboardInitAuth(false, emit, d)).toEqual([]);
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ state: 'unknown', reason: 'detection-failed' }));
});
it('rescans then continues with successful providers', async () => {
  const d = dependencies(); d.ui.select = vi.fn().mockResolvedValueOnce('rescan').mockResolvedValueOnce('continue');
  expect(await onboardInitAuth(true, vi.fn(), d)).toEqual(['pi']); expect(d.readStatus).toHaveBeenCalledTimes(2);
});
it('skip does not report configured backends', async () => {
  const d = dependencies(); d.ui.select = vi.fn(async () => 'skip');
  expect(await onboardInitAuth(true, vi.fn(), d)).toEqual([]);
  expect(usableBackends({ ...snapshot, accounts: snapshot.accounts.map(a => ({ ...a, state: 'expired' })) })).toEqual([]);
});
it('Claude installer is guarded, confirmed, verified and retryable', async () => {
  const d = dependencies(); const installer = { installed: vi.fn(() => true), install: vi.fn() };
  expect(await ensureClaudeForLogin(d.ui, installer)).toBe(true); expect(d.ui.confirm).not.toHaveBeenCalled();
  installer.installed.mockReturnValue(false);
  expect(await ensureClaudeForLogin(d.ui, installer)).toBe(false); expect(installer.install).not.toHaveBeenCalled();
  d.ui.confirm = vi.fn(async () => true); installer.installed.mockReturnValueOnce(false).mockReturnValueOnce(true);
  expect(await ensureClaudeForLogin(d.ui, installer)).toBe(true); expect(installer.install).toHaveBeenCalledTimes(1);
  installer.installed.mockReturnValue(false); installer.install.mockImplementation(() => { throw new Error('private'); });
  await expect(ensureClaudeForLogin(d.ui, installer)).rejects.toThrow('installation failed');
});
it('CLI drives the real shared flow service with a fake consumer only', async () => {
  const d = dependencies();
  d.service = createAuthLoginService({ piConsumerFactory: provider => async interaction => {
    expect(await interaction.prompt({ type: 'secret', message: 'Fixture key' })).toBe('test-only-secret');
    return { provider, authType: 'api_key', expiresAt: null };
  } });
  const result = await runAuthLoginCli(['--backend', 'pi', '--provider', 'fixture', '--auth-type', 'api_key'], d);
  expect(result.exitCode).toBe(0); expect(JSON.parse(result.stdout).sync.configured).toBe(false);
  expect(JSON.stringify(result)).not.toContain('test-only-secret');
});
