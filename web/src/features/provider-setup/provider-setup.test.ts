// input:  onboarding controller, auth and profile fixtures
// output: auth-type readiness and refresh regression tests
// pos:    Provider setup behavior specification
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { describe, expect, it, vi } from 'vitest';
import type { AuthAccountStatus, ConfigProfileEntry } from '@cortex-agent/ui-contract';
import { ProviderSetupController, readyProfiles, orderedProviders } from './provider-setup';

const account = (patch: Partial<AuthAccountStatus> = {}): AuthAccountStatus => ({
  backend: 'pi', provider: 'openai', label: 'OpenAI', state: 'logged-in',
  capabilities: ['oauth', 'api_key'], authType: 'oauth', source: 'local',
  expiresAt: null, refreshExpiresAt: null, inUse: false, credentials: [], ...patch,
});
const profile = (patch: Partial<ConfigProfileEntry> = {}): ConfigProfileEntry => ({
  name: 'pi-ready', backend: 'pi', provider: 'openai', model: 'gpt-test', mode: null,
  thinking: null, claudeBackend: null, extraOption: {}, extraEnvKeys: [], fallbackCount: 0, ...patch,
});
function fixture() {
  const ports = {
    status: vi.fn().mockResolvedValue({ accounts: [account()], piRuntime: { available: true }, generatedAt: 'now' }),
    config: vi.fn().mockResolvedValue({ profiles: { defaultProfile: 'pi-ready', profiles: [profile()] } }),
    sync: vi.fn().mockResolvedValue({ configured: true }),
    select: vi.fn().mockResolvedValue({}),
    claude: vi.fn().mockResolvedValue({ installed: false, version: null }),
    install: vi.fn().mockResolvedValue({ installed: true, version: '1' }),
    canInstall: () => true,
  };
  return { ports, controller: new ProviderSetupController(ports) };
}

describe('provider onboarding', () => {
  it('prioritizes configured providers and searches other dynamic capabilities', () => {
    const rows = orderedProviders([account({ provider: 'z', label: 'Z' }), account({ provider: 'a', label: 'A', state: 'unknown', capabilities: ['api_key'] })], '');
    expect(rows.map(row => row.provider)).toEqual(['z', 'a']);
    expect(orderedProviders(rows, 'a')[0].capabilities).toEqual(['api_key']);
  });
  it.each(['unknown', 'expired', 'logged-out'] as const)('does not count %s credentials as ready', state => {
    expect(readyProfiles([profile()], [account({ state })], true, true)).toEqual([]);
  });
  it('requires matching provider, runtime and installed CC independently', () => {
    expect(readyProfiles([profile()], [account({ provider: 'anthropic' })], true, true)).toEqual([]);
    expect(readyProfiles([profile()], [account()], false, true)).toEqual([]);
    const cc = profile({ backend: 'claude', provider: null, mode: 'subscription' });
    const auth = account({ backend: 'claude', provider: 'anthropic' });
    expect(readyProfiles([cc], [auth], true, false)).toEqual([]);
    expect(readyProfiles([cc], [auth], false, true)).toEqual([cc]);
    expect(readyProfiles([cc], [auth], false, null)).toEqual([]);
  });
  it('matches Claude plan profiles to subscription credentials, not the active API key', () => {
    const cc = profile({ backend: 'claude', provider: null, mode: 'plan' });
    const api = account({ backend: 'claude', provider: 'anthropic', authType: 'api_key' });
    expect(readyProfiles([cc], [api], true, true)).toEqual([]);
    expect(readyProfiles([{ ...cc, mode: 'api' }], [api], true, true)).toHaveLength(1);
    expect(readyProfiles([cc], [{ ...api, authType: 'oauth' }], true, true)).toEqual([cc]);
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
    expect(ports.config).toHaveBeenCalledTimes(2);
    expect(controller.state.sync).toBe('success');
  });
  it('exposes configured:false and rejected sync; retry never reinstalls CC', async () => {
    const { ports, controller } = fixture();
    await controller.load();
    ports.sync.mockResolvedValueOnce({ configured: false, reason: 'no-endpoints' });
    await controller.refresh();
    expect(controller.state.error).toContain('no-endpoints');
    expect(controller.canContinue()).toBe(false);
    ports.sync.mockRejectedValueOnce(new Error('sync denied'));
    await controller.refresh();
    expect(controller.state.error).toBe('sync denied');
    await controller.refresh();
    expect(controller.canContinue()).toBe(true);
    expect(ports.install).not.toHaveBeenCalled();
  });
  it('requires explicit selection on default mismatch and writes only that name', async () => {
    const { ports, controller } = fixture();
    ports.config.mockResolvedValue({ profiles: { defaultProfile: 'old', profiles: [profile()] } });
    await controller.load();
    expect(controller.canContinue()).toBe(false);
    expect(ports.select).not.toHaveBeenCalled();
    await controller.select('not-real');
    expect(ports.select).not.toHaveBeenCalled();
    ports.config.mockResolvedValue({ profiles: { defaultProfile: 'pi-ready', profiles: [profile()] } });
    await controller.select('pi-ready');
    expect(ports.select).toHaveBeenCalledWith('pi-ready');
    expect(controller.canContinue()).toBe(true);
  });
  it('keeps CC optional, unknown detection honest and installation explicit/retry-local', async () => {
    const { ports, controller } = fixture();
    ports.claude.mockRejectedValueOnce(new Error('detect denied'));
    await controller.load();
    expect(controller.state.claude).toBeNull();
    expect(controller.state.claudeError).toBe('detect denied');
    expect(controller.canContinue()).toBe(true);
    await controller.detectClaude();
    ports.install.mockRejectedValueOnce(new Error('install denied'));
    expect(await controller.prepareClaude()).toBe(false);
    expect(controller.state.claudeError).toBe('install denied');
    expect(await controller.prepareClaude()).toBe(true);
    expect(ports.status).toHaveBeenCalledTimes(1);
    expect(ports.install).toHaveBeenCalledTimes(2);
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
