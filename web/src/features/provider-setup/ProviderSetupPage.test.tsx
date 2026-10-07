import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { en } from '@/i18n/vocab';
import type { AuthAccountStatus } from '@cortex-agent/ui-contract';
import { ProviderSetupPage, ProviderSetupView } from './ProviderSetupPage';
import { useTRPCClient } from '@/lib/trpc';
import { ProviderSetupController } from './provider-setup';
vi.mock('@/i18n', async importOriginal => ({ ...await importOriginal<typeof import('@/i18n')>(), useVocab: () => en, useLang: () => 'en' }));
vi.mock('@/features/auth/LoginFlowModal', () => ({ LoginFlowModal: (props: object) => <aside {...props} /> }));
vi.mock('@/lib/trpc', () => ({ useTRPCClient: vi.fn() }));
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('./SetupHeader', () => ({ SetupHeader: () => null }));
vi.mock('./setup-native', () => ({ canSetupClaude: () => false, setupClaude: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const initialConnection = { serverUrl: 'http://127.0.0.1:3004', token: 'fixture-original', providerSetupPending: true };
function pageFixture(defaultProfile = '') {
  const status = vi.fn().mockResolvedValue({ accounts: [{ backend: 'pi', provider: 'openai', label: 'OpenAI',
    state: 'logged-in', capabilities: ['oauth'], credentials: [] }], piRuntime: { available: true } });
  const config = vi.fn().mockResolvedValue({ profiles: { defaultProfile, profiles: [
    { name: 'ready', backend: 'pi', provider: 'openai', model: 'fixture-model' },
  ] } });
  const sync = vi.fn().mockResolvedValue({ configured: true });
  const select = vi.fn();
  vi.mocked(useTRPCClient).mockReturnValue({ auth: { status: { query: status }, syncGateway: { mutate: sync } },
    config: { get: { query: config }, set: { mutate: select } } } as unknown as ReturnType<typeof useTRPCClient>);
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('__TAURI__', { core: { invoke } });
  vi.stubGlobal('__CORTEX_DESKTOP__', true);
  vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { ...initialConnection });
  return { invoke, sync, config, status, select };
}
async function renderPage() {
  let view!: ReturnType<typeof create>;
  await act(async () => { view = create(<ProviderSetupPage />); });
  return view;
}
const exitButton = (view: ReturnType<typeof create>, action: string) => view.root.findByProps({ 'data-action': `setup-${action}` });
function pendingSave(invoke: ReturnType<typeof vi.fn>) {
  let resolve!: () => void;
  invoke.mockReturnValue(new Promise<void>(done => { resolve = done; }));
  return resolve;
}

it.each(['skip', 'continue'])('actual page persists %s before navigating and blocks repeat exits', async action => {
  const { invoke, sync, select, status, config } = pageFixture('ready');
  if (action === 'skip') {
    status.mockResolvedValue({ accounts: [], piRuntime: { available: true } });
    config.mockResolvedValue({ profiles: null });
  }
  const resolve = pendingSave(invoke);
  const view = await renderPage();
  const click = exitButton(view, action).props.onClick;
  act(() => { void click(); void click(); });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith('finish_provider_setup', {
    serverUrl: initialConnection.serverUrl, token: initialConnection.token,
  });
  expect(navigate).not.toHaveBeenCalled();
  expect(exitButton(view, 'skip').props.disabled).toBe(true);
  expect(exitButton(view, 'continue').props.disabled).toBe(true);
  await act(async () => { resolve(); });
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith('/workbench', { replace: true });
  expect(sync).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  act(() => view.unmount());
});

it.each(['', 'nondefault'])('actual page refuses Continue without a ready default (%s), but permits skip', async defaultProfile => {
  const { invoke } = pageFixture(defaultProfile);
  const view = await renderPage();
  expect(exitButton(view, 'continue').props.disabled).toBe(true);
  await act(async () => exitButton(view, 'continue').props.onClick());
  expect(invoke).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  await act(async () => exitButton(view, 'skip').props.onClick());
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledTimes(1);
  act(() => view.unmount());
});

it('login completion refreshes readiness but never finishes onboarding', async () => {
  const { invoke, sync } = pageFixture('ready');
  const view = await renderPage();
  await act(async () => view.root.findByType('aside').props.onDone({ step: 'done', flowId: 'fixture-login' }));
  expect(sync).toHaveBeenCalledTimes(1);
  expect(exitButton(view, 'continue').props.disabled).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  act(() => view.unmount());
});

it.each(['skip', 'continue'])('%s keeps the page on save failure, hides raw details and permits retry', async action => {
  const { invoke } = pageFixture('ready');
  invoke.mockRejectedValueOnce(new Error('save failed: fixture-original /private/credentials'));
  const view = await renderPage();
  await act(async () => exitButton(view, action).props.onClick());
  expect(navigate).not.toHaveBeenCalled();
  expect(view.root.findByProps({ role: 'alert' }).children).toEqual(['Could not save setup progress. Try again.']);
  expect(JSON.stringify(view.toJSON())).not.toContain('fixture-original');
  expect(exitButton(view, action).props.disabled).toBe(false);
  await act(async () => exitButton(view, action).props.onClick());
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(navigate).toHaveBeenCalledTimes(1);
  act(() => view.unmount());
});

it('captures original identity and pending once, despite a later injected connection change', async () => {
  const { invoke } = pageFixture();
  const view = await renderPage();
  // Mutate the injected object as well as rerendering: the page must own a snapshot.
  Object.assign(Reflect.get(globalThis, '__CORTEX_DESKTOP_CONFIG'), {
    serverUrl: 'http://127.0.0.1:4004', token: 'fixture-replacement', providerSetupPending: false,
  });
  act(() => view.update(<ProviderSetupPage />));
  await act(async () => exitButton(view, 'skip').props.onClick());
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith('finish_provider_setup', {
    serverUrl: initialConnection.serverUrl, token: initialConnection.token,
  });
  act(() => view.unmount());
});

it.each([
  ['browser', 'skip'], ['browser', 'continue'], ['legacy', 'skip'], ['legacy', 'continue'],
  ['unmarked', 'skip'], ['unmarked', 'continue'], ['remote', 'skip'], ['remote', 'continue'],
])('%s manual provider visits never invoke completion on %s', async (mode, action) => {
  const { invoke } = pageFixture('ready');
  if (mode === 'browser') vi.stubGlobal('__CORTEX_DESKTOP__', false);
  else vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { serverUrl: mode === 'remote' ? 'https://remote.example' : initialConnection.serverUrl,
    token: 'fixture-token', ...(mode === 'legacy' ? {} : { providerSetupPending: false }) });
  const view = await renderPage();
  vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { ...initialConnection });
  act(() => view.update(<ProviderSetupPage />));
  await act(async () => exitButton(view, action).props.onClick());
  expect(invoke).not.toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith('/workbench', { replace: true });
  act(() => view.unmount());
});

it('always offers warned skip, disables unready continuation and refreshes login success', async () => {
  const sync = vi.fn().mockResolvedValue({ configured: false, reason: 'no-endpoints' });
  const controller = new ProviderSetupController({
    status: async () => ({ accounts: [], piRuntime: { available: true, version: null, entry: null, error: null }, generatedAt: '' }),
    config: async () => ({ profiles: null }), sync, select: vi.fn(), claude: vi.fn(), install: vi.fn(), canInstall: () => false,
  });
  const leave = vi.fn();
  let view!: ReturnType<typeof create>;
  await act(async () => { await controller.load(); view = create(<ProviderSetupView controller={controller} leave={leave} />); });
  expect(view.root.findByProps({ 'data-action': 'setup-continue' }).props.disabled).toBe(true);
  act(() => view.root.findByProps({ 'data-action': 'setup-skip' }).props.onClick());
  expect(leave).toHaveBeenCalledTimes(1);
  await act(async () => view.root.findByType('aside').props.onDone({ step: 'done', flowId: 'login' }));
  expect(sync).toHaveBeenCalledTimes(1);
  view.unmount();
});
it('opens the login target for the tapped provider row', async () => {
  const accounts = ['anthropic', 'openai-codex', 'deepseek', 'custom-provider'].map(provider => ({
    backend: 'pi', provider, label: provider, capabilities: ['api_key'], authType: null,
    state: 'logged-out', source: null, expiresAt: null, refreshExpiresAt: null, inUse: false, credentials: [],
  } as AuthAccountStatus));
  const controller = new ProviderSetupController({
    status: async () => ({ accounts, piRuntime: { available: true, version: null, entry: null, error: null }, generatedAt: '' }),
    config: async () => ({ profiles: null }), sync: vi.fn(), select: vi.fn(), claude: vi.fn(), install: vi.fn(), canInstall: () => false,
  });
  let view!: ReturnType<typeof create>;
  await act(async () => { await controller.load(); view = create(<ProviderSetupView controller={controller} leave={vi.fn()} />); });
  const rows = view.root.findAll(node => node.type === 'div' && node.props['data-account-row'] !== undefined);
  expect(rows.map(row => row.props['data-account-row'])).toEqual(['anthropic', 'custom-provider', 'deepseek', 'openai-codex']);
  expect(view.root.findAll(node => node.props['data-provider-brand'] === 'server')).toHaveLength(1);
  const row = rows.find(node => node.props['data-account-row'] === 'deepseek')!;
  act(() => row.findByType('button').props.onClick());
  expect(view.root.findByType('aside').props.target).toEqual({ backend: 'pi', provider: 'deepseek', authType: 'api_key', label: 'deepseek' });
  view.unmount();
});
