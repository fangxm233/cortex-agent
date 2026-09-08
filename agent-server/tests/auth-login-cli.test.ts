// input:  login CLI, fake status and login service
// output: bilingual login, SIGINT/expiry, secret and handoff-fence regressions
// pos:    Isolated CLI authentication boundary tests
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { setLocale, t } from '../src/core/i18n.js';
import { initEn, initZh } from '../src/core/locales/slices/init.js';
import { runAuthLoginCli, type LoginCliDeps } from '../src/entry/auth-login-cli.js';
import type { AuthStatusSnapshot } from '../src/domain/auth/auth-status.js';
import type { LoginFlowState } from '../src/domain/auth/login-flow.js';
import { runAuthCli } from '../src/entry/auth-cli.js';

const snapshot = { accounts: [{ backend: 'pi', provider: 'test', label: 'Test', capabilities: ['api_key'], state: 'logged-out' }, { backend: 'claude', provider: 'anthropic', label: 'Anthropic', capabilities: ['oauth'] }], piRuntime: { available: true } } as AuthStatusSnapshot;
const state = (step: LoginFlowState['step']): LoginFlowState => ({ flowId: 'test-flow', backend: 'pi', provider: 'test', authType: 'api_key', step, pendingPrompt: step === 'prompt' ? { kind: 'secret', message: 'Key' } : null, notice: null, expiresAt: new Date(Date.now() + 60000).toISOString() }) as LoginFlowState;
function deps(): LoginCliDeps {
  return { tty: true, readStatus: vi.fn(async () => snapshot), ui: { select: vi.fn(async (_message, options) => options[0].value), secret: vi.fn(async () => 'private-key'), confirm: vi.fn(async () => true), notify: vi.fn() }, service: { start: vi.fn(async () => state('prompt')), respond: vi.fn(async () => state('done')), getState: vi.fn(() => state('done')), cancel: vi.fn(async () => state('cancelled')) }, ensureClaude: vi.fn(async () => true), sync: vi.fn(async () => ({ configured: true, endpoints: 1, profiles: ['test'] })) };
}
const args = ['--backend', 'pi', '--provider', 'test', '--auth-type', 'api_key'];
describe('auth login CLI', () => {
  let harnessInterrupts: ReturnType<typeof process.rawListeners>;
  beforeEach(() => {
    // The test-home harness exits the worker on SIGINT. Preserve its once wrappers
    // while exercising the actual CLI process listener, then restore them unchanged.
    harnessInterrupts = process.rawListeners('SIGINT');
    process.removeAllListeners('SIGINT');
  });
  afterEach(() => {
    process.removeAllListeners('SIGINT');
    for (const listener of harnessInterrupts) process.on('SIGINT', listener);
    setLocale('en');
  });
  it.each(['en', 'zh'] as const)('localizes help, selections and safe errors in %s without translating protocol values', async locale => {
    setLocale(locale);
    const d = deps();
    const help = await runAuthLoginCli(['--help'], d);
    expect(help.stdout).toContain(t('init.auth.help'));
    expect(help.stdout).toContain(t('cmd.auth.cli.helpExamples'));
    expect((await runAuthCli(['--help'], d.readStatus)).stdout).toContain(t('init.auth.loginDescription'));
    const result = await runAuthLoginCli([], d);
    expect(result.exitCode).toBe(0);
    expect(d.ui.select).toHaveBeenNthCalledWith(1, t('init.auth.backend'), expect.arrayContaining([{ value: 'pi', label: t('init.auth.bundled') }]));
    expect(d.ui.select).toHaveBeenNthCalledWith(2, t('init.auth.provider'), [{ value: 'test', label: `Test (${t('cmd.auth.state.logged-out')})` }]);
    expect(d.ui.select).toHaveBeenNthCalledWith(3, t('init.auth.type'), [{ value: 'api_key', label: t('init.auth.api_key') }]);
    expect(JSON.parse(result.stdout)).toMatchObject({ backend: 'pi', provider: 'test', authType: 'api_key', state: 'done', inferenceVerified: false });
    d.tty = false;
    expect((await runAuthLoginCli(args, d)).stderr).toBe(t('init.auth.ttyRequired'));
    expect((await runAuthLoginCli(['--api-key', 'private-key'], d)).stderr).toBe(t('init.auth.invalidOptions'));
  });
  it('keeps onboarding locale keys and placeholders in parity', () => {
    for (const key of Object.keys(initEn).filter(key => key.startsWith('init.auth.')) as Array<keyof typeof initEn>) {
      expect(initZh[key]).toBeTruthy();
      expect(initZh[key]).not.toBe(initEn[key]);
      expect(initZh[key].match(/\$\{\w+\}/g) ?? []).toEqual(initEn[key].match(/\$\{\w+\}/g) ?? []);
    }
  });
  it.each(['secret', 'select'] as const)('SIGINT aborts a pending %s promptly with 130 and removes its listener', async kind => {
    const d = deps();
    const listeners = process.listenerCount('SIGINT');
    d.service.start = vi.fn(async () => ({ ...state('prompt'), pendingPrompt: { kind, message: 'Fixture prompt', options: [{ id: 'fixture', label: 'Fixture' }] } }));
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let promptSignal: AbortSignal | undefined;
    const prompt = (signal?: AbortSignal) => new Promise<string>((_resolve, reject) => {
      promptSignal = signal;
      signal!.addEventListener('abort', () => reject(new Error('private-key')), { once: true });
      entered();
    });
    d.ui.secret = vi.fn((_message, signal) => prompt(signal));
    d.ui.select = vi.fn((_message, _options, signal) => prompt(signal));
    const pending = runAuthLoginCli(args, d);
    await ready;
    process.emit('SIGINT');
    const result = await pending;
    expect(promptSignal?.aborted).toBe(true);
    expect(result).toEqual({ exitCode: 130, stdout: JSON.stringify({ ok: false, state: 'cancelled' }), stderr: t('init.auth.cancelled') });
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(d.service.respond).not.toHaveBeenCalled();
    expect(d.service.cancel).toHaveBeenCalledWith('test-flow');
    expect(d.sync).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(listeners);
  });
  it('does not hand off a secret resolved concurrently with SIGINT', async () => {
    const d = deps();
    d.ui.secret = vi.fn(async () => { process.emit('SIGINT'); return 'private-key'; });
    expect((await runAuthLoginCli(args, d)).exitCode).toBe(130);
    expect(d.service.respond).not.toHaveBeenCalled();
  });
  it('reports prompt timeout as expiry rather than operator cancellation', async () => {
    const d = deps();
    d.service.start = vi.fn(async () => ({ ...state('prompt'), expiresAt: new Date(Date.now() + 40).toISOString() }));
    d.ui.secret = vi.fn((_message, signal) => new Promise<string>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('private-key')), { once: true });
    }));
    const result = await runAuthLoginCli(args, d);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(t('init.auth.expired'));
    expect(d.service.respond).not.toHaveBeenCalled();
    expect(d.service.cancel).toHaveBeenCalledWith('test-flow');
  });
  it('respects service refusal to cancel after credential handoff without exposing its error', async () => {
    const d = deps();
    d.service.respond = vi.fn(async () => { process.emit('SIGINT'); return state('running'); });
    d.service.cancel = vi.fn(async () => { throw new Error('private-key: handoff in progress'); });
    const result = await runAuthLoginCli(args, d);
    expect(result.exitCode).toBe(130);
    expect(d.service.respond).toHaveBeenCalledTimes(1);
    expect(d.service.cancel).toHaveBeenCalledTimes(1);
    expect(d.sync).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private-key');
  });
  it('auth dispatcher exposes login help without invoking status', async () => {
    const readStatus = vi.fn(async () => snapshot);
    expect((await runAuthCli(['login', '-h'], readStatus)).stdout).toContain('--auth-type');
    expect((await runAuthCli(['--help'], readStatus)).stdout).toContain('login');
    expect(readStatus).not.toHaveBeenCalled();
  });
  it('fails fast without a TTY and never scans or starts', async () => {
    const d = deps(); d.tty = false;
    expect((await runAuthLoginCli(args, d)).exitCode).toBe(1);
    expect(d.readStatus).not.toHaveBeenCalled(); expect(d.service.start).not.toHaveBeenCalled();
  });
  it.each(['--help', '-h'])('supports %s without TTY', async flag => {
    const d = deps(); d.tty = false;
    expect((await runAuthLoginCli([flag], d)).stdout).toContain('Examples:');
  });
  it.each([['--backend', 'bad'], ['--auth-type', 'bad'], ['--api-key', 'private-key'], ['--provider']])('rejects invalid options without leaking values: %s', async (...input) => {
    const d = deps(); const result = await runAuthLoginCli(input, d);
    expect(result.exitCode).toBe(1); expect(result.stderr).not.toContain('private-key'); expect(d.service.start).not.toHaveBeenCalled();
  });
  it('hands secrets only to the shared service and syncs after success', async () => {
    const d = deps(); const result = await runAuthLoginCli(args, d);
    expect(result.exitCode).toBe(0); expect(d.service.respond).toHaveBeenCalledWith('test-flow', 'private-key');
    expect(JSON.parse(result.stdout).sync.configured).toBe(true); expect(JSON.stringify(result)).not.toContain('private-key'); expect(d.ensureClaude).not.toHaveBeenCalled();
  });
  it('does not login when Claude installation is declined', async () => {
    const d = deps(); d.ensureClaude = vi.fn(async () => false);
    expect((await runAuthLoginCli(['--backend', 'claude'], d)).exitCode).toBe(130); expect(d.service.start).not.toHaveBeenCalled();
  });
  it('cancels a pending secret prompt', async () => {
    const d = deps(); d.ui.secret = vi.fn(async () => { throw new Error('cancelled'); });
    expect((await runAuthLoginCli(args, d)).exitCode).not.toBe(0); expect(d.service.cancel).toHaveBeenCalledWith('test-flow'); expect(d.sync).not.toHaveBeenCalled();
  });
  it('reports expired flows and sanitized failures', async () => {
    const d = deps(); d.service.start = vi.fn(async () => ({ ...state('running'), expiresAt: new Date(0).toISOString() }));
    expect((await runAuthLoginCli(args, d)).stderr).toContain('expired');
    d.service.start = vi.fn(async () => { throw new Error('private-key'); });
    expect(JSON.stringify(await runAuthLoginCli(args, d))).not.toContain('private-key');
  });
  it('rejects unsupported provider/auth combinations', async () => {
    const d = deps(); expect((await runAuthLoginCli(['--backend', 'pi', '--provider', 'test', '--auth-type', 'oauth'], d)).exitCode).toBe(1); expect(d.service.start).not.toHaveBeenCalled();
  });
});
