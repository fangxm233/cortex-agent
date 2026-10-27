import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { en } from '@/i18n/vocab';
import type { AuthAccountStatus, ConfigModels } from '@cortex-agent/ui-contract';
import { ProviderSetupPage, ProviderSetupView } from './ProviderSetupPage';
import { useTRPCClient } from '@/lib/trpc';
import { ProviderSetupController } from './provider-setup';
vi.mock('@/i18n', async importOriginal => ({ ...await importOriginal<typeof import('@/i18n')>(), useVocab: () => en, useLang: () => 'en' }));
vi.mock('@/features/auth/LoginFlowModal', () => ({ LoginFlowModal: (props: object) => <aside {...props} /> }));
vi.mock('@/lib/trpc', () => ({ useTRPCClient: vi.fn() }));
vi.mock('@/design/Select', () => ({ Select: (props: object) => <button {...props} /> }));
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('./SetupHeader', () => ({ SetupHeader: () => null }));
vi.mock('./setup-native', () => ({ canSetupClaude: () => false, setupClaude: vi.fn() }));
vi.mock('@/features/settings/controllers/usePrivacyController', () => ({
  usePrivacyController: () => ({ info: { data: undefined }, pending: false, setEnabled: vi.fn() }),
}));
vi.mock('@/features/settings/controllers/useAutostartController', () => ({
  useAutostartController: () => ({ state: null, pending: false, failed: false, set: vi.fn() }),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const initialConnection = { serverUrl: 'http://127.0.0.1:3004', token: 'fixture-original', providerSetupPending: true };
const emptyModels: ConfigModels = { default: null, favorites: [], memory: {} };
const catalog = async () => ({ routes: [], piPending: false });
function pageFixture(defaultModel = '') {
  const status = vi.fn().mockResolvedValue({ accounts: [{ backend: 'pi', provider: 'openai', label: 'OpenAI',
    state: 'logged-in', capabilities: ['oauth'], credentials: [] }], piRuntime: { available: true } });
  const ref = { backend: 'pi', provider: 'openai', model: 'fixture-model' } as const;
  const config = vi.fn().mockResolvedValue({ models: {
    default: defaultModel ? { ...ref, provider: defaultModel === 'ready' ? 'openai' : 'unready', thinking: null, mode: 'openai' } : null,
    favorites: [ref], memory: { [JSON.stringify(['pi', 'openai', 'fixture-model'])]: { thinking: null, mode: 'openai' } },
  } });
  const sync = vi.fn().mockResolvedValue({ configured: true });
  const select = vi.fn();
  const sharingSet = vi.fn();
  const sharing = { get: { query: vi.fn().mockResolvedValue({ enabled: false, name: '', org: '', email: '' }) }, set: { mutate: sharingSet } };
  vi.mocked(useTRPCClient).mockReturnValue({ auth: { status: { query: status }, syncGateway: { mutate: sync } },
    config: { get: { query: config } }, models: { catalog: { query: catalog }, setDefault: { mutate: select } }, usageSharing: sharing } as unknown as ReturnType<typeof useTRPCClient>);
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('__TAURI__', { core: { invoke } });
  vi.stubGlobal('__CORTEX_DESKTOP__', true);
  vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { ...initialConnection });
  return { invoke, sync, config, status, select, sharingSet };
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
    config.mockResolvedValue({ models: emptyModels });
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

it.each(['', 'nondefault'])('actual page refuses Continue without a ready default (%s), but permits skip', async defaultModel => {
  const { invoke } = pageFixture(defaultModel);
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

it.each([['ready', false], ['', true]])('the optional leaderboard card leaves Continue as it was (default %j)', async (defaultModel, blocked) => {
  const { invoke, sharingSet } = pageFixture(defaultModel);
  const view = await renderPage();
  const card = view.root.findByProps({ 'data-usage-sharing': 'setup' });
  expect(card.findByProps({ role: 'switch' }).props['aria-checked']).toBe(false);
  expect(exitButton(view, 'continue').props.disabled).toBe(blocked);
  // Switched on with an unsaved, incomplete identity.
  act(() => card.findByProps({ role: 'switch' }).props.onClick());
  expect(exitButton(view, 'continue').props.disabled).toBe(blocked);
  await act(async () => exitButton(view, blocked ? 'skip' : 'continue').props.onClick());
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(sharingSet).not.toHaveBeenCalled();
  act(() => view.unmount());
});

it('writes the selected favorite as a complete default engine selection', async () => {
  const { select } = pageFixture();
  const view = await renderPage();
  const picker = view.root.findByProps({ id: 'setup-model' });
  const key = JSON.stringify(['pi', 'openai', 'fixture-model']);
  expect(picker.props.density).toBe('bare');
  expect(picker.props.className).toBe('setup-input');
  expect(view.root.findByProps({ htmlFor: 'setup-model' })).toBeDefined();
  await act(async () => picker.props.onValueChange(key));
  expect(select).toHaveBeenCalledWith({ selection: {
    backend: 'pi', provider: 'openai', model: 'fixture-model', thinking: null, mode: 'openai',
  } });
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
    config: async () => ({ models: emptyModels }), catalog, sync, select: vi.fn(), claude: vi.fn(), install: vi.fn(), canInstall: () => false,
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
  const accounts = ['anthropic', 'openai-codex', 'openai', 'deepseek', 'custom-provider'].map(provider => ({
    backend: 'pi', provider, label: provider, capabilities: ['api_key'], authType: null,
    state: 'logged-out', source: null, expiresAt: null, refreshExpiresAt: null, inUse: false, credentials: [],
  } as AuthAccountStatus));
  const controller = new ProviderSetupController({
    status: async () => ({ accounts, piRuntime: { available: true, version: null, entry: null, error: null }, generatedAt: '' }),
    config: async () => ({ models: emptyModels }), catalog, sync: vi.fn(), select: vi.fn(), claude: vi.fn(), install: vi.fn(), canInstall: () => false,
  });
  let view!: ReturnType<typeof create>;
  await act(async () => { await controller.load(); view = create(<ProviderSetupView controller={controller} leave={vi.fn()} />); });
  const rows = view.root.findAll(node => node.type === 'div' && node.props['data-account-row'] !== undefined);
  expect(rows.map(row => row.props['data-account-row'])).toEqual(['openai', 'openai-codex', 'deepseek', 'anthropic', 'custom-provider']);
  const group = (name: string) => view.root.findByProps({ 'data-setup-providers': name })
    .findAll(node => node.type === 'div' && node.props['data-account-row'] !== undefined).map(node => node.props['data-account-row']);
  expect(group('popular')).toEqual(['openai', 'openai-codex', 'deepseek']);
  expect(group('more')).toEqual(['anthropic', 'custom-provider']);
  const headings = view.root.findAllByType('h2').map(node => node.children.filter(child => typeof child === 'string').join(''));
  expect(headings.indexOf('Claude Code')).toBeLessThan(headings.indexOf(en.setupProviders));
  expect(headings.indexOf('Claude Code')).toBeGreaterThanOrEqual(0);
  expect(view.root.findAll(node => node.props['data-provider-brand'] === 'server')).toHaveLength(1);
  const row = rows.find(node => node.props['data-account-row'] === 'deepseek')!;
  act(() => row.findByType('button').props.onClick());
  expect(view.root.findByType('aside').props.target).toEqual({ backend: 'pi', provider: 'deepseek', authType: 'api_key', label: 'deepseek' });
  view.unmount();
});
it('shows no Claude detection status where this client cannot detect it', async () => {
  const controller = new ProviderSetupController({
    status: async () => ({ accounts: [], piRuntime: { available: true, version: null, entry: null, error: null }, generatedAt: '' }),
    config: async () => ({ models: emptyModels }), catalog, sync: vi.fn(), select: vi.fn(), claude: vi.fn(), install: vi.fn(), canInstall: () => false,
  });
  let view!: ReturnType<typeof create>;
  await act(async () => { await controller.load(); view = create(<ProviderSetupView controller={controller} leave={vi.fn()} />); });
  const pills = view.root.findAll(node => node.type === 'span' && node.props.className === 'setup-pill');
  expect(pills[0].children.join('')).toBe(en.setupOptional);
  expect(JSON.stringify(view.toJSON())).not.toContain(en.setupUnknown);
  view.unmount();
});
