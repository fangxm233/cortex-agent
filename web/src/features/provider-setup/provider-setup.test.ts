import { describe, expect, it, vi } from 'vitest';
import type { AuthAccountStatus, ConfigModels, EngineSelection } from '@cortex-agent/ui-contract';
import { POPULAR_PROVIDERS, ProviderSetupController, readyModels, setupErrorText, splitPopular } from './provider-setup';
import { modelKey } from '@/lib/model-selection';
import { en, zh } from '@/i18n';

const account = (patch: Partial<AuthAccountStatus> = {}): AuthAccountStatus => ({
  backend: 'pi', provider: 'openai', label: 'OpenAI', state: 'logged-in',
  capabilities: ['oauth', 'api_key'], authType: 'oauth', source: 'local',
  expiresAt: null, refreshExpiresAt: null, inUse: false, credentials: [], ...patch,
});
const selection = (patch: Partial<EngineSelection> = {}): EngineSelection => ({
  backend: 'pi', provider: 'openai', model: 'gpt-test', mode: 'openai', thinking: null, ...patch,
});
const models = (patch: Partial<ConfigModels> = {}): ConfigModels => ({
  default: selection(), favorites: [selection()], memory: {}, ...patch,
});
function fixture() {
  const ports = {
    status: vi.fn().mockResolvedValue({ accounts: [account()], piRuntime: { available: true }, generatedAt: 'now' }),
    config: vi.fn().mockResolvedValue({ models: models() }),
    catalog: vi.fn().mockResolvedValue({ piPending: false, routes: [{ backend: 'pi', provider: 'openai',
      endpoint: 'openai', modes: ['openai'], models: ['gpt-test'], source: 'pi' }] }),
    sync: vi.fn().mockResolvedValue({ configured: true }), select: vi.fn().mockResolvedValue({}),
    claude: vi.fn().mockResolvedValue({ installed: false, version: null }),
    install: vi.fn().mockResolvedValue({ installed: true, version: '1' }), canInstall: () => true,
  };
  return { ports, controller: new ProviderSetupController(ports) };
}

describe('provider onboarding model readiness', () => {
  it.each(['unknown', 'expired', 'logged-out'] as const)('does not count %s credentials as ready', state => {
    expect(readyModels([selection()], [account({ state })], true, true)).toEqual([]);
  });
  it('requires matching provider, runtime and installed CC independently', () => {
    expect(readyModels([selection()], [account({ provider: 'anthropic' })], true, true)).toEqual([]);
    expect(readyModels([selection()], [account()], false, true)).toEqual([]);
    const cc = selection({ backend: 'claude', provider: null, mode: 'plan' });
    const auth = account({ backend: 'claude', provider: 'anthropic' });
    expect(readyModels([cc], [auth], true, false)).toEqual([]);
    expect(readyModels([cc], [auth], false, true)).toEqual([cc]);
    expect(readyModels([cc], [auth], false, null)).toEqual([]);
    expect(readyModels([selection({ mode: '' })], [account()], true, true)).toEqual([]);
  });
  it('matches Claude plan selections to subscription credentials, including inactive slots', () => {
    const cc = selection({ backend: 'claude', provider: null, mode: 'plan' });
    const api = account({ backend: 'claude', provider: 'anthropic', authType: 'api_key' });
    expect(readyModels([cc], [api], true, true)).toEqual([]);
    expect(readyModels([{ ...cc, mode: 'api' }], [api], true, true)).toHaveLength(1);
    expect(readyModels([cc], [{ ...api, authType: 'oauth' }], true, true)).toEqual([cc]);
    const credentials = [{ authType: 'oauth', state: 'expiring' }] as AuthAccountStatus['credentials'];
    expect(readyModels([cc], [{ ...api, credentials }], true, true)).toEqual([cc]);
  });
  it('loads without installing or syncing, then rescans and syncs after login once', async () => {
    const { ports, controller } = fixture();
    await controller.load();
    expect(ports.install).not.toHaveBeenCalled();
    expect(ports.sync).not.toHaveBeenCalled();
    expect(controller.canContinue()).toBe(true);
    await controller.loginDone('flow-1');
    await controller.loginDone('flow-1');
    expect(ports.sync).toHaveBeenCalledTimes(1);
    expect(ports.status).toHaveBeenCalledTimes(2);
    expect(controller.state.sync).toBe('success');
  });
  it('exposes configured:false and rejected sync; retry never reinstalls CC', async () => {
    const { ports, controller } = fixture();
    await controller.load();
    ports.sync.mockResolvedValueOnce({ configured: false, reason: 'EACCES: models.json' });
    await controller.refresh();
    expect(controller.state.error).toContain('EACCES');
    expect(controller.canContinue()).toBe(false);
    ports.sync.mockRejectedValueOnce(new Error('sync denied'));
    await controller.refresh();
    expect(controller.state.error).toBe('sync denied');
    await controller.refresh();
    expect(controller.canContinue()).toBe(true);
    expect(ports.install).not.toHaveBeenCalled();
  });
  it('treats a rescan with nothing logged in yet as no change, not a failure', async () => {
    const { ports, controller } = fixture();
    ports.sync.mockResolvedValueOnce({ configured: false, reason: 'no-endpoints' });
    await controller.refresh();
    expect(controller.state.error).toBeNull();
    expect(controller.state.sync).toBe('idle');
  });
  it('selects only usable favorites and writes a full remembered selection', async () => {
    const { ports, controller } = fixture();
    const memory = { [modelKey(selection())]: { thinking: 'high', mode: 'openai' } };
    ports.config.mockResolvedValue({ models: models({ default: null, memory }) });
    await controller.load();
    expect(controller.canContinue()).toBe(false);
    await controller.select('not-real');
    expect(ports.select).not.toHaveBeenCalled();
    ports.config.mockResolvedValue({ models: models({ memory }) });
    await controller.select(modelKey(selection()));
    expect(ports.select).toHaveBeenCalledWith(selection({ thinking: 'high' }));
    expect(controller.canContinue()).toBe(true);
  });
  it('checks the actual default route rather than a remembered favorite with the same identity', async () => {
    const { ports, controller } = fixture();
    const cc = selection({ backend: 'claude', provider: null, mode: 'api' });
    ports.claude.mockResolvedValue({ installed: true, version: '1' });
    ports.status.mockResolvedValue({ accounts: [account({ backend: 'claude', provider: 'anthropic' })], piRuntime: { available: true } });
    ports.config.mockResolvedValue({ models: models({ default: cc, favorites: [cc],
      memory: { [modelKey(cc)]: { thinking: null, mode: 'plan' } } }) });
    await controller.load();
    expect(controller.available()).toHaveLength(1);
    expect(controller.canContinue()).toBe(false);
  });
  it('allows a usable default even after it was removed from favorites', async () => {
    const { ports, controller } = fixture();
    ports.config.mockResolvedValue({ models: models({ favorites: [] }) });
    await controller.load();
    expect(controller.available()).toEqual([]);
    expect(controller.canContinue()).toBe(true);
  });
  it('keeps CC optional, unknown detection honest and installation explicit/retry-local', async () => {
    const { ports, controller } = fixture();
    ports.claude.mockRejectedValueOnce(new Error('detect denied'));
    await controller.load();
    expect(controller.state.claude).toBeNull();
    expect(controller.canContinue()).toBe(true);
    await controller.detectClaude();
    ports.install.mockRejectedValueOnce(new Error('install denied'));
    expect(await controller.prepareClaude()).toBe(false);
    expect(await controller.prepareClaude()).toBe(true);
    expect(await controller.prepareClaude()).toBe(true);
    expect(ports.install).toHaveBeenCalledTimes(2);
  });
  it('never calls installation in a browser/remote context', async () => {
    const { ports, controller } = fixture();
    ports.canInstall = () => false;
    await controller.load();
    expect(await controller.prepareClaude()).toBe(false);
    expect(ports.install).not.toHaveBeenCalled();
    expect(ports.claude).not.toHaveBeenCalled();
  });
  it('does not continue on failed auth detection', async () => {
    const { ports, controller } = fixture();
    ports.status.mockRejectedValue(new Error('offline'));
    await controller.load();
    expect(controller.state.error).toBe('offline');
    expect(controller.canContinue()).toBe(false);
  });
});

describe('setupErrorText', () => {
  it('localizes setup codes and leaves raw detail alone', () => {
    expect(setupErrorText('not-installed', zh)).toBe('Claude Code 仍未安装');
    expect(setupErrorText('no-endpoints', zh)).toBe('no-endpoints');
    expect(setupErrorText('claude_local_required', zh)).toContain('本机 Cortex 设置连接');
    expect(setupErrorText('claude_install_failed: exit 1: npm ERR! 404', zh)).toBe('Claude Code 安装失败 (exit 1: npm ERR! 404)');
    expect(setupErrorText('claude_install_failed: exit 1: npm ERR! 404', en)).toBe('Claude Code installation failed (exit 1: npm ERR! 404)');
    expect(setupErrorText('unknown_code: x', zh)).toBe('unknown_code: x');
  });
});

describe('splitPopular', () => {
  it('lists popular providers in the curated order and keeps the rest in place', () => {
    const rows = ['zai', 'anthropic', 'openai-codex', 'groq', 'openai', 'deepseek'].map(provider => ({ provider }));
    const { popular, more } = splitPopular(rows);
    expect(popular.map(p => p.provider)).toEqual(['openai', 'openai-codex', 'zai', 'deepseek']);
    expect(more.map(p => p.provider)).toEqual(['anthropic', 'groq']);
    expect(POPULAR_PROVIDERS).toHaveLength(9);
  });
});
