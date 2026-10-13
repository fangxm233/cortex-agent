import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { _testSetRegistry } from '../src/domain/remote/machine-registry.js';
import {
  getOnlineDevices, isDeviceOnline, sendCommand, setClientUpdateHooks, setHubLifecycleHooks,
  startClientManager, stopClientManager,
} from '../src/domain/remote/client-manager.js';

const hooks = vi.hoisted(() => ({ emit: vi.fn().mockResolvedValue([]) }));
vi.mock('@core/hook-bus.js', () => ({ emitCortexEvent: hooks.emit }));
const local = { cortexPath: '/home/local', gpuCount: 0 }; // No SSH: the server's own client.
const onHello = vi.fn();
const onLifecycleHello = vi.fn();
const sockets: WebSocket[] = [];

beforeEach(() => {
  vi.stubEnv('CORTEX_CLIENT_TOKEN', 'registration-test-token');
  _testSetRegistry({ local, remote: { ...local, ssh: 'user@remote' } });
  hooks.emit.mockReset().mockResolvedValue([]);
  onHello.mockClear();
  onLifecycleHello.mockClear();
  setClientUpdateHooks({ onHello, onUpdateResult: vi.fn() });
  setHubLifecycleHooks({ onStart: vi.fn(), onDeviceGone: vi.fn(), onHello: onLifecycleHello, onStop: async () => {} });
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await stopClientManager();
  _testSetRegistry({});
  vi.unstubAllEnvs();
});

async function startHub(host = '127.0.0.1'): Promise<number> {
  const on = vi.spyOn(WebSocketServer.prototype, 'on');
  startClientManager(0, host);
  const index = on.mock.calls.findIndex(([event]) => event === 'connection');
  const server = on.mock.contexts[index] as WebSocketServer;
  on.mockRestore();
  await vi.waitFor(() => expect(server.address()).toBeTruthy());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  return address.port;
}

async function hello(port: number, device: string, host = '127.0.0.1'): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${host}:${port}`, { headers: { 'x-cortex-token': 'registration-test-token' } });
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'hello', device, platform: 'linux', gpuCount: 0 }));
  return ws;
}

async function expectClosed(ws: WebSocket, code: number, reason: string): Promise<void> {
  let closed: [number, string] | undefined;
  ws.once('close', (value, text) => { closed = [value, text.toString()]; });
  await vi.waitFor(() => expect(closed).toEqual([code, reason]));
}

test.each(['unknown', 'toString', '__proto__'])('rejects unregistered hello %s before admission side effects', async device => {
  const ws = await hello(await startHub(), device);
  await expectClosed(ws, 4005, 'Unknown device');
  expect(getOnlineDevices()).toEqual([]);
  expect(hooks.emit).not.toHaveBeenCalled();
  expect(onHello).not.toHaveBeenCalled();
  expect(onLifecycleHello).not.toHaveBeenCalled();
  await expect(sendCommand(device, { action: 'bash', params: {} })).rejects.toThrow('not online');
});

test.each(['local', 'remote'])('admits registered %s clients, including entries without SSH', async device => {
  await hello(await startHub(), device);
  await vi.waitFor(() => expect(isDeviceOnline(device)).toBe(true));
  expect(onHello).toHaveBeenCalledWith(device, null);
  expect(onLifecycleHello).toHaveBeenCalled();
});

test('a listener hostname is not the registered device identity', async () => {
  vi.stubEnv('CORTEX_CLIENT_HOST', 'localhost');
  const port = await startHub(process.env.CORTEX_CLIENT_HOST);
  await hello(port, 'local', 'localhost');
  await vi.waitFor(() => expect(isDeviceOnline('local')).toBe(true));
  expect(isDeviceOnline('localhost')).toBe(false);
});

test('rejects reconnect after the registry entry is removed', async () => {
  const port = await startHub();
  const ws = await hello(port, 'remote');
  await vi.waitFor(() => expect(isDeviceOnline('remote')).toBe(true));
  ws.close();
  await vi.waitFor(() => expect(isDeviceOnline('remote')).toBe(false));
  _testSetRegistry({ local });
  onHello.mockClear();
  await expectClosed(await hello(port, 'remote'), 4005, 'Unknown device');
  expect(isDeviceOnline('remote')).toBe(false);
  expect(onHello).not.toHaveBeenCalled();
});

test('preserves missing-name and duplicate-device close codes', async () => {
  const port = await startHub();
  await expectClosed(await hello(port, ''), 4001, 'Missing device name');
  await hello(port, 'local');
  await vi.waitFor(() => expect(isDeviceOnline('local')).toBe(true));
  await expectClosed(await hello(port, 'local'), 4002, 'Device already connected');
  expect(isDeviceOnline('local')).toBe(true);
});
