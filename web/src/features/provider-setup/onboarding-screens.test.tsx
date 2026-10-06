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
    installServer: vi.fn(), enableUi: vi.fn(), enableAutostart: vi.fn(), connect: vi.fn(),
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
  act(() => view.root.findByProps({ children: en.onbEditSettings }).props.onClick());
  expect(view.root.findByProps({ id: 'onb-machine' }).props.value).toBe('desk');
});
