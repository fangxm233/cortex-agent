import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { en } from '@/i18n/vocab';
import { RemoteConnectScreen } from './ConnectScreen';
import { LocalSetupView } from './LocalSetupScreen';
import { LocalSetupFlow, type LocalSetupPorts } from './local-setup';
vi.mock('@/i18n', () => ({ useVocab: () => en, useLang: () => 'en' }));
afterEach(() => vi.unstubAllGlobals());

const text = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());

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
    enableUi: vi.fn(), enableAutostart: vi.fn(), connect: vi.fn(), cancelInstall: vi.fn(),
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
    enableUi: vi.fn(), enableAutostart: vi.fn(), connect: vi.fn(),
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
  await act(async () => { reject(new Error('RUNTIME_INTEGRITY_FAILED: checksum /private/runtime')); await preparing; });
  expect(details.open).toBe(false);
  expect(view.root.findByProps({ role: 'alert' }).findByType('p').children).toEqual([en.onbErrRuntimeIntegrityFailed]);
  expect(view.root.findByType('pre').children.join('')).toContain('checksum /private/runtime');
  expect(ports.connect).not.toHaveBeenCalled();
  expect(view.root.findAllByProps({ 'data-action': 'onb-cancel' })).toHaveLength(0);
  expect(view.root.findByProps({ 'data-action': 'onb-retry' }).props.disabled).toBe(false);
});
