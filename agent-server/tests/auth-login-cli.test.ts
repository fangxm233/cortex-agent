// input:  login CLI, fake status and login service
// output: login argument, secret and lifecycle regression tests
// pos:    Isolated CLI authentication boundary tests
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { describe, it, expect, vi } from 'vitest';
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
