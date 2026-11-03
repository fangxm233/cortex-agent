import { describe, expect, it, vi } from 'vitest';
import type { AuthAccountStatus, ConfigModels, EngineSelection, ModelCatalogSnapshot } from '@cortex-agent/ui-contract';
import { POPULAR_PROVIDERS, ProviderSetupController, readyModels, setupErrorText, splitPopular } from './provider-setup';
import { modelKey } from '@/lib/model-selection';
import { en, zh } from '@/i18n';

const account = (patch: Partial<AuthAccountStatus> = {}): AuthAccountStatus => ({
  backend: 'pi', provider: 'openai', label: 'OpenAI', connection: null, isDefault: true, identity: null, state: 'logged-in',
  capabilities: ['oauth', 'api_key'], authType: 'oauth', source: 'local',
  expiresAt: null, refreshExpiresAt: null, inUse: false, credentials: [], ...patch,
});
const selection = (patch: Partial<EngineSelection> = {}): EngineSelection => ({
  backend: 'pi', provider: 'openai', model: 'gpt-test', connection: null, thinking: null, ...patch,
});
const models = (patch: Partial<ConfigModels> = {}): ConfigModels => ({
  default: selection(), favorites: [selection()], memory: {}, ...patch,
});
function fixture() {
  const ports = {
    status: vi.fn().mockResolvedValue({ accounts: [account()], piRuntime: { available: true }, generatedAt: 'now' }),
    config: vi.fn().mockResolvedValue({ models: models() }),
    catalog: vi.fn().mockResolvedValue({ piPending: false, routes: [{ backend: 'pi', provider: 'openai',
      endpoint: 'openai', connections: [], models: ['gpt-test'], source: 'pi' }] }),
    sync: vi.fn().mockResolvedValue({ configured: true }), select: vi.fn().mockResolvedValue({}),
    claude: vi.fn().mockResolvedValue({ installed: false, version: null }),
    install: vi.fn().mockResolvedValue({ installed: true, version: '1' }), canInstall: () => true,
  };
  return { ports, controller: new ProviderSetupController(ports) };
}

const CLAUDE_CATALOG = { piPending: false, thinkingLevels: { claude: [], pi: [] }, routes: [{
  backend: 'claude', provider: null, endpoint: 'anthropic', connections: ['subscription', 'qwen'],
  models: ['opus', 'qwen-coder'], source: 'builtin', modelThinking: {}, modelConnections: { 'qwen-coder': ['qwen'] },
}] } as unknown as ModelCatalogSnapshot;

describe('provider onboarding model readiness', () => {
  it.each(['unknown', 'expired', 'logged-out'] as const)('does not count %s credentials as ready', state => {
    expect(readyModels([selection()], [account({ state })], true, true, null)).toEqual([]);
  });
  it('requires matching provider, runtime and installed CC independently', () => {
    expect(readyModels([selection()], [account({ provider: 'anthropic' })], true, true, null)).toEqual([]);
    expect(readyModels([selection()], [account()], false, true, null)).toEqual([]);
    const cc = selection({ backend: 'claude', provider: null, model: 'opus' });
    expect(readyModels([cc], [], true, false, CLAUDE_CATALOG)).toEqual([]);
    expect(readyModels([cc], [], false, true, CLAUDE_CATALOG)).toEqual([cc]);
    expect(readyModels([cc], [], false, null, CLAUDE_CATALOG)).toEqual([]);
  });
  it('counts a Claude model ready when a connection serves it, whichever it names', () => {
    const cc = selection({ backend: 'claude', provider: null, model: 'qwen-coder' });
    expect(readyModels([cc], [], true, true, CLAUDE_CATALOG)).toEqual([cc]);
    expect(readyModels([{ ...cc, connection: 'subscription' }], [], true, true, CLAUDE_CATALOG)).toHaveLength(1);
    // No Claude connection on this host: nothing in the catalog can run it.
    expect(readyModels([cc], [], true, true, { ...CLAUDE_CATALOG, routes: [] })).toEqual([]);
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
    ports.sync.mockResolvedValueOnce({ configured: false, reason: 'no-routes' });
    await controller.refresh();
    expect(controller.state.error).toBeNull();
    expect(controller.state.sync).toBe('idle');
  });
  it('selects only usable favorites and writes a full remembered selection', async () => {
    const { ports, controller } = fixture();
    const memory = { [modelKey(selection())]: { thinking: 'high', connection: null } };
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
  it('checks the default against the catalog rather than a remembered favorite with the same identity', async () => {
    const { ports, controller } = fixture();
    const cc = selection({ backend: 'claude', provider: null, connection: 'api' });
    ports.claude.mockResolvedValue({ installed: true, version: '1' });
    ports.config.mockResolvedValue({ models: models({ default: cc, favorites: [cc], memory: { [modelKey(cc)]: { thinking: null } } }) });
    // The catalog has no Claude route: nothing on this host can run the default yet.
    await controller.load();
    expect(controller.available()).toEqual([]);
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
    expect(setupErrorText('no-routes', zh)).toBe('no-routes');
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
