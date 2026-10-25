import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { en } from '@/i18n/vocab';
import { RemoteConnectScreen } from './ConnectScreen';
import { LocalSetupScreen, LocalSetupView } from './LocalSetupScreen';
import { LocalSetupFlow, type LocalSetupPorts } from './local-setup';
vi.mock('@/i18n', () => ({ useVocab: () => en, useLang: () => 'en' }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const text = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());

function nativeSetup(os = 'linux', homeExists = false) {
  const results: Record<string, unknown> = {
    setup_probe: { node: 'v22.19.0', nodeOk: true, npm: '10', git: 'git', cortexBin: '/bin/cortex',
      serverVersion: '2026.10.1', serverOk: true, homeExists, hostname: 'host', os,
      ...(os === 'windows' ? { node: null, nodeOk: false, npm: null, git: null } : {}) },
    setup_install_server: { cortexBin: '/bin/cortex', serverVersion: '2026.10.1' },
    setup_run_init: { version: null, uiUrl: 'http://127.0.0.1:3004', clientToken: 't' },
    setup_enable_ui: { url: 'http://127.0.0.1:14004', token: 't' },
    setup_start_daemon: true,
  };
  const invoke = vi.fn(async (command: string, _args?: unknown) => results[command]);
  vi.stubGlobal('__TAURI__', { core: { invoke } });
  return { invoke, results };
}

it.each(['setup_install_server', 'setup_run_init', 'setup_start_daemon', 'connect'].flatMap(pending =>
  ['linux', 'windows'].map(os => [os, pending])))(
  'keeps the real %s screen to one row without a form while awaiting %s', async (os, pending) => {
    vi.useFakeTimers();
    const { invoke, results } = nativeSetup(os);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    invoke.mockImplementation(async command => { if (command === pending) await waiting; return results[command]; });
    const leave = vi.fn();
    let view!: ReactTestRenderer;
    await act(async () => { view = create(<LocalSetupScreen otherOptions={vi.fn()} leave={leave} />); });
    expect(invoke.mock.calls.map(call => call[0])).toContain(pending);
    expect(view.root.findAllByType('form')).toHaveLength(0);
    expect(view.root.findAllByType('input')).toHaveLength(0);
    expect(view.root.findAllByProps({ 'data-action': 'onb-start' })).toHaveLength(0);
    expect(view.root.findAllByProps({ className: 'onb-status-row' })).toHaveLength(1);
    expect(view.root.findByProps({ className: 'onb-status-row' }).props['data-status']).toBe('running');
    expect(leave).not.toHaveBeenCalled();
    await act(async () => { release(); });
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(leave).toHaveBeenCalledWith('index.html#/setup/providers');
    act(() => view.unmount());
  });

it.each(['linux', 'windows'].flatMap(os => [false, true].map(homeExists => ({ os, homeExists }))))(
  'real $os connect marks only fresh installs (homeExists=$homeExists) and respects saved intent', async ({ os, homeExists }) => {
  vi.useFakeTimers();
  const { invoke, results } = nativeSetup(os, homeExists);
  results.connect = { serverUrl: 'http://127.0.0.1:3004', token: 't', providerSetupPending: homeExists };
  const leave = vi.fn();
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<LocalSetupScreen otherOptions={vi.fn()} leave={leave} />); });
  expect(invoke).toHaveBeenCalledWith('connect', {
    serverUrl: homeExists ? 'http://127.0.0.1:14004' : 'http://127.0.0.1:3004', token: 't',
    local: { cortexBin: '/bin/cortex', ...(!homeExists ? { providerSetupPending: true } : {}) },
  });
  expect(leave).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(600); });
  expect(leave).toHaveBeenCalledWith(homeExists ? 'index.html#/setup/providers' : 'index.html');
  act(() => view.unmount());
});

it.each(['linux', 'windows'])('retries installation from the real %s screen and continues automatically with defaults', async os => {
  vi.useFakeTimers();
  const { invoke, results } = nativeSetup(os);
  let failing = true;
  invoke.mockImplementation(async command => {
    if (command === 'setup_install_server' && failing) throw new Error('SERVER_INSTALL_FAILED');
    return results[command];
  });
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<LocalSetupScreen otherOptions={vi.fn()} leave={vi.fn()} />); });
  expect(view.root.findAllByType('form')).toHaveLength(0);
  expect(text(view)).not.toContain(en.onbEditSettings);
  failing = false;
  await act(async () => view.root.findByProps({ 'data-action': 'onb-retry' }).props.onClick());
  expect(invoke).toHaveBeenCalledWith('setup_run_init', { run: 'start', bin: '/bin/cortex',
    answers: { lang: 'en', machineName: 'host', backends: ['pi'], port: 3004, installService: false, telemetry: { enabled: true } } });
  expect(invoke).toHaveBeenCalledWith('connect', expect.anything());
  expect(view.root.findAllByType('form')).toHaveLength(0);
  act(() => view.unmount());
});

it.each(['linux', 'windows'])('preserves the %s endpoint and daemon until explicitly repaired in the view', async os => {
  vi.useFakeTimers();
  const { invoke, results } = nativeSetup(os, true);
  results.setup_start_daemon = false;
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<LocalSetupScreen otherOptions={vi.fn()} leave={vi.fn()} />); });
  expect(invoke).toHaveBeenCalledWith('setup_enable_ui', { run: 'start', bin: '/bin/cortex', port: undefined });
  expect(view.root.findAllByType('form')).toHaveLength(0);
  await act(async () => view.root.findByProps({ 'data-action': 'onb-retry' }).props.onClick());
  expect(invoke).toHaveBeenLastCalledWith('setup_start_daemon', { run: 'start', bin: '/bin/cortex',
    url: 'http://127.0.0.1:14004', token: 't', restart: false });
  act(() => view.root.findByProps({ children: en.onbEditSettings }).props.onClick());
  act(() => view.root.findByProps({ id: 'onb-port' }).props.onChange({ target: { value: '15004' } }));
  results.setup_start_daemon = true;
  await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(invoke).toHaveBeenCalledWith('setup_enable_ui', { run: 'start', bin: '/bin/cortex', port: 15004 });
  expect(invoke).toHaveBeenCalledWith('setup_start_daemon', { run: 'start', bin: '/bin/cortex',
    url: 'http://127.0.0.1:14004', token: 't', restart: true });
  expect(invoke.mock.calls.map(call => call[0])).not.toContain('setup_run_init');
  expect(invoke.mock.calls.map(call => call[0])).not.toContain('setup_enable_autostart');
  act(() => view.unmount());
});

it('keeps Windows cancellation pending until install settles, then offers automatic retry', async () => {
  vi.useFakeTimers();
  const { invoke, results } = nativeSetup('windows');
  let reject!: (error: Error) => void;
  const installing = new Promise<never>((_, fail) => { reject = fail; });
  invoke.mockImplementation(async command => command === 'setup_install_server' ? installing : results[command]);
  const leave = vi.fn();
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<LocalSetupScreen otherOptions={vi.fn()} leave={leave} />); });
  await act(async () => view.root.findByProps({ 'data-action': 'onb-cancel' }).props.onClick());
  expect(invoke).toHaveBeenLastCalledWith('setup_cancel_install', undefined);
  expect(view.root.findAllByProps({ 'data-action': 'onb-retry' })).toHaveLength(0);
  expect(invoke.mock.calls.map(call => call[0])).not.toContain('setup_run_init');
  expect(leave).not.toHaveBeenCalled();
  await act(async () => { reject(new Error('SETUP_CANCELLED')); });
  expect(view.root.findByProps({ role: 'alert' }).findByType('p').children).toEqual([en.onbErrSetupCancelled]);
  expect(view.root.findAllByProps({ 'data-action': 'onb-cancel' })).toHaveLength(0);
  invoke.mockImplementation(async command => results[command]);
  await act(async () => view.root.findByProps({ 'data-action': 'onb-retry' }).props.onClick());
  expect(view.root.findAllByType('form')).toHaveLength(0);
  expect(invoke).toHaveBeenCalledWith('connect', expect.anything());
  await act(async () => { vi.advanceTimersByTime(600); });
  expect(leave).toHaveBeenCalledWith('index.html#/setup/providers');
  act(() => view.unmount());
});

it('verifies, saves the connection and opens the workbench', async () => {
  const invoke = vi.fn(async (command: string) =>
    command === 'get_connection_config' ? { serverUrl: 'https://saved.example', token: null } : null);
  vi.stubGlobal('__TAURI__', { core: { invoke } });
  const fetch = vi.fn().mockResolvedValue({ status: 401 });
  vi.stubGlobal('fetch', fetch);
  const leave = vi.fn();
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<RemoteConnectScreen leave={leave} />); });
  const url = view.root.findByProps({ id: 'onb-server-url' });
  expect(url.props.value).toBe('https://saved.example');
  act(() => view.root.findByProps({ id: 'onb-token' }).props.onChange({ target: { value: ' t ' } }));
  const submit = () => view.root.findByType('form').props.onSubmit({ preventDefault() {} });

  await act(async () => submit());
  expect(text(view)).toContain(en.onbTokenRejected);
  expect(invoke).not.toHaveBeenCalledWith('connect', expect.anything());

  fetch.mockResolvedValue({ status: 200 });
  await act(async () => view.root.findByProps({ 'data-action': 'onb-test' }).props.onClick());
  expect(text(view)).toContain(en.onbVerified);
  expect(leave).not.toHaveBeenCalled();

  await act(async () => submit());
  expect(invoke).toHaveBeenCalledWith('connect', { serverUrl: 'https://saved.example', token: 't' });
  expect(leave).toHaveBeenCalledWith('index.html');
  expect(view.root.findAllByProps({ className: 'onb-back' })).toHaveLength(0);
});

it('shows a failed start with its fix, and edits reopen the submitted settings', async () => {
  const ports: LocalSetupPorts = {
    probe: async () => ({ node: 'v22', nodeOk: true, npm: '10', git: 'git', cortexBin: '/bin/cortex', serverVersion: '2026.10.1',
      serverOk: true, homeExists: false, hostname: 'host', os: 'linux' }),
    installServer: async () => ({ cortexBin: '/bin/cortex', serverVersion: '2026.10.1' }),
    enableUi: vi.fn(), enableAutostart: vi.fn(), setTerminalCli: vi.fn(), connect: vi.fn(), cancelInstall: vi.fn(),
    runInit: async () => ({ version: null, uiUrl: 'http://127.0.0.1:3004', clientToken: 't' }),
    startDaemon: async () => false,
  };
  const flow = new LocalSetupFlow(ports);
  let view!: ReactTestRenderer;
  await act(async () => {
    await flow.prepare();
    view = create(<LocalSetupView flow={flow} log="" otherOptions={vi.fn()} clearLog={vi.fn()} />);
  });
  act(() => view.root.findByProps({ id: 'onb-machine' }).props.onChange({ target: { value: 'desk' } }));
  await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(text(view)).toContain(en.onbErrDaemonTimeout);
  expect(view.root.findAllByProps({ 'data-action': 'onb-cancel' })).toHaveLength(0);
  act(() => view.root.findByProps({ children: en.onbEditSettings }).props.onClick());
  expect(view.root.findByProps({ id: 'onb-machine' }).props.value).toBe('desk');
  expect(text(view)).toContain(en.onbTerminalCommand);
  expect(text(view)).not.toContain('2026.10.1');
});

it('keeps installation compact and technical diagnostics folded even after failure', async () => {
  let reject!: (error: Error) => void;
  const installing = new Promise<never>((_, fail) => { reject = fail; });
  const ports: LocalSetupPorts = {
    probe: async () => ({ node: 'v24.21.0', nodeOk: true, npm: '11.9', git: 'git version 2.50',
      cortexBin: '/private/cortex', serverVersion: '2026.10.1', serverOk: true,
      homeExists: false, hostname: 'host', os: 'macos' }),
    installServer: () => installing, runInit: vi.fn(), startDaemon: vi.fn(), cancelInstall: vi.fn(),
    enableUi: vi.fn(), enableAutostart: vi.fn(), setTerminalCli: vi.fn(), connect: vi.fn(),
  };
  const flow = new LocalSetupFlow(ports);
  const details = { open: false };
  let view!: ReactTestRenderer;
  let preparing!: Promise<void>;
  await act(async () => {
    view = create(<LocalSetupView flow={flow} log="" otherOptions={vi.fn()} clearLog={vi.fn()} />,
      { createNodeMock: element => element.type === 'details' ? details : null });
    preparing = flow.prepare();
  });
  expect(view.root.findAllByProps({ className: 'onb-status-row' })).toHaveLength(1);
  expect(text(view)).not.toMatch(/v24|11\.9|git version|2026\.10|private|onb-probe-details/);
  expect(view.root.findAllByType('input')).toHaveLength(0);
  expect(details.open).toBe(false);
  await act(async () => view.root.findByProps({ 'data-action': 'onb-cancel' }).props.onClick());
  expect(ports.cancelInstall).toHaveBeenCalledTimes(1);
  await act(async () => { reject(new Error('RUNTIME_MISSING: unpack /private/runtime')); await preparing; });
  expect(details.open).toBe(false);
  expect(view.root.findByProps({ role: 'alert' }).findByType('p').children).toEqual([en.onbErrRuntimeMissing]);
  expect(view.root.findByType('pre').children.join('')).toContain('unpack /private/runtime');
  expect(ports.connect).not.toHaveBeenCalled();
  expect(view.root.findAllByProps({ 'data-action': 'onb-cancel' })).toHaveLength(0);
  expect(view.root.findByProps({ 'data-action': 'onb-retry' }).props.disabled).toBe(false);
});
