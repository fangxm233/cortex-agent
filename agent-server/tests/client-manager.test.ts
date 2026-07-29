// input:  Vitest, client manager, WebSockets, HookBus mock
// output: Client lifecycle hooks, commands and authentication tests
// pos:    Verifies remote client registration and routing
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeEach, afterAll, vi } from 'vitest';
import assert from 'node:assert/strict';

const hookBus = vi.hoisted(() => ({
  emitCortexEvent: vi.fn(),
}));

vi.mock('@core/hook-bus.js', () => ({
  emitCortexEvent: hookBus.emitCortexEvent,
}));
import { WebSocket, WebSocketServer } from 'ws';
import {
  getOnlineDevices,
  isDeviceOnline,
  sendCommand,
  startClientManager,
  stopClientManager,
  buildRemoteSpawnCommand,
  buildRemoteInstallCommand,
  startRemoteClient,
  _setSshExecForTesting,
  _setMachineRegistryProviderForTesting,
  _getRestartTimerCount,
  _testReset,
} from '../src/domain/remote/client-manager.js';

// The WS server now enforces a bearer token on the upgrade handshake. Set one for the
// whole test file; clients must send it via the `x-cortex-token` header.
const WS_TOKEN = 'test-ws-token';
process.env.CORTEX_CLIENT_TOKEN = WS_TOKEN;
const authHeaders = { 'x-cortex-token': WS_TOKEN };

// Allocate an ephemeral port by listening on 0 once, capturing the port, then closing.
async function findEphemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = new WebSocketServer({ port: 0 });
    probe.on('listening', () => {
      const addr = probe.address();
      if (typeof addr === 'object' && addr) {
        const port = addr.port;
        probe.close(() => resolve(port));
      } else {
        reject(new Error('WebSocketServer address() did not return an object'));
      }
    });
    probe.on('error', reject);
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

beforeEach(() => {
  hookBus.emitCortexEvent.mockReset();
  hookBus.emitCortexEvent.mockResolvedValue([]);
});

// A single test-suite-wide cleanup guard: if any test leaks a started server we stop it here.
afterAll(() => {
  try { stopClientManager(); } catch {}
});

test('getOnlineDevices returns [] and isDeviceOnline returns false when no server started', () => {
  // With no WebSocket server running and no clients, the module-level `devices` Map is empty.
  // (If a previous test leaked state we still expect at most the previously-registered devices,
  //  but stopClientManager clears them — and this is the first test in the file.)
  assert.deepEqual(getOnlineDevices(), []);
  assert.equal(isDeviceOnline('any-device'), false);
});

test('sendCommand rejects immediately with "not online" for unknown device', async () => {
  await assert.rejects(
    () => sendCommand('device-does-not-exist', { action: 'bash', params: { cmd: 'echo hi' } }),
    /not online/,
  );
});

test('stopClientManager is idempotent — safe to call when not started', () => {
  assert.doesNotThrow(() => stopClientManager());
  // Second call should also be a no-op.
  assert.doesNotThrow(() => stopClientManager());
});

test('start + hello handshake populates devices; stopClientManager tears everything down', async (t) => {
  const port = await findEphemeralPort();
  startClientManager(port);
  t.onTestFinished(() => stopClientManager());

  // Connect a fake client and send a hello frame.
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: authHeaders });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  ws.send(JSON.stringify({ type: 'hello', device: 'mock-device-1', platform: 'linux', capabilities: ['bash'] }));
  await waitFor(() => isDeviceOnline('mock-device-1'));

  const online = getOnlineDevices();
  assert.equal(online.length, 1);
  assert.equal(online[0].device, 'mock-device-1');
  assert.equal(online[0].platform, 'linux');
  assert.deepEqual(online[0].capabilities, ['bash']);
  assert.ok(online[0].connectedAt instanceof Date);
  assert.ok(online[0].lastHeartbeat instanceof Date);

  ws.close();
  await waitFor(() => !isDeviceOnline('mock-device-1'));
});

test('client lifecycle emits connected and disconnected matcher payloads', async (t) => {
  const port = await findEphemeralPort();
  startClientManager(port);
  t.onTestFinished(() => stopClientManager());

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: authHeaders });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  ws.send(JSON.stringify({ type: 'hello', device: 'event-device', platform: 'linux', capabilities: [] }));
  await waitFor(() => isDeviceOnline('event-device'));
  assert.deepEqual(hookBus.emitCortexEvent.mock.calls[0], [
    'cortex:client.connected',
    { device: 'event-device' },
  ]);

  ws.close(1000, 'test complete');
  await waitFor(() => !isDeviceOnline('event-device'));
  await waitFor(() => hookBus.emitCortexEvent.mock.calls.length === 2);
  assert.deepEqual(hookBus.emitCortexEvent.mock.calls[1], [
    'cortex:client.disconnected',
    { device: 'event-device', reason: 'test complete' },
  ]);
});

test('failing client hooks do not change connection lifecycle outcomes', async (t) => {
  const port = await findEphemeralPort();
  startClientManager(port);
  t.onTestFinished(() => stopClientManager());
  hookBus.emitCortexEvent.mockRejectedValue(new Error('hook failed'));

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: authHeaders });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  ws.send(JSON.stringify({ type: 'hello', device: 'failure-device', platform: 'linux', capabilities: [] }));
  await waitFor(() => isDeviceOnline('failure-device'));
  ws.close(1000, 'finished');
  await waitFor(() => !isDeviceOnline('failure-device'));

  assert.deepEqual(hookBus.emitCortexEvent.mock.calls.map(([event]) => event), [
    'cortex:client.connected',
    'cortex:client.disconnected',
  ]);
});

test('manager shutdown emits a failing disconnected hook without changing teardown', async () => {
  const port = await findEphemeralPort();
  startClientManager(port);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: authHeaders });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'hello', device: 'shutdown-device', platform: 'linux', capabilities: [] }));
  await waitFor(() => isDeviceOnline('shutdown-device'));
  hookBus.emitCortexEvent.mockClear();
  hookBus.emitCortexEvent.mockRejectedValueOnce(new Error('hook failed'));

  assert.doesNotThrow(() => stopClientManager());

  assert.equal(isDeviceOnline('shutdown-device'), false);
  assert.deepEqual(hookBus.emitCortexEvent.mock.calls, [[
    'cortex:client.disconnected',
    { device: 'shutdown-device', reason: 'Server shutting down' },
  ]]);
});

// --- Regression: WMI Win32_Process.Create cannot resolve npm-installed `.cmd` shims
//     via PATH, so the Windows spawn command must wrap with `cmd.exe /c`.
//     Without the wrapper, WMI returns ReturnValue=9 (Path Not Found) and an empty
//     ProcessId, which serializes to "" over SSH and the server logs
//     `Failed to parse PID for <device>: ""`. Observed live on my-pc 2026-05-14 → 17.
// --- WS upgrade auth: the server rejects connections without a valid bearer token ---

test('WS handshake rejects a connection with no x-cortex-token header', async (t) => {
  const port = await findEphemeralPort();
  startClientManager(port);
  t.onTestFinished(() => stopClientManager());

  const ws = new WebSocket(`ws://127.0.0.1:${port}`); // no auth header
  const outcome = await new Promise<'open' | 'rejected'>((resolve) => {
    ws.once('open', () => resolve('open'));
    ws.once('error', () => resolve('rejected'));
    ws.once('unexpected-response', () => resolve('rejected'));
  });
  assert.equal(outcome, 'rejected');
  assert.equal(isDeviceOnline('should-never-register'), false);
  try { ws.close(); } catch {}
});

test('WS handshake rejects a connection with a wrong token', async (t) => {
  const port = await findEphemeralPort();
  startClientManager(port);
  t.onTestFinished(() => stopClientManager());

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { 'x-cortex-token': 'wrong-token' } });
  const outcome = await new Promise<'open' | 'rejected'>((resolve) => {
    ws.once('open', () => resolve('open'));
    ws.once('error', () => resolve('rejected'));
    ws.once('unexpected-response', () => resolve('rejected'));
  });
  assert.equal(outcome, 'rejected');
  try { ws.close(); } catch {}
});

test('WS handshake accepts a connection carrying the correct token', async (t) => {
  const port = await findEphemeralPort();
  startClientManager(port);
  t.onTestFinished(() => stopClientManager());

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: authHeaders });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'hello', device: 'mock-auth-ok', platform: 'linux', capabilities: [] }));
  await waitFor(() => isDeviceOnline('mock-auth-ok'));
  ws.close();
  await waitFor(() => !isDeviceOnline('mock-auth-ok'));
});

// --- Remote spawn injects the client token so SSH-launched clients can authenticate ---

test('buildRemoteSpawnCommand injects CORTEX_CLIENT_TOKEN on Linux remotes when given a token', () => {
  const cmd = buildRemoteSpawnCommand({ cortexPath: '/home/x', gpuCount: 0, ssh: 'user@host' }, 'sektok123');
  assert.match(cmd, /CORTEX_CLIENT_TOKEN='sektok123'/);
  assert.match(cmd, /nohup cortex-client/);
  assert.match(cmd, /echo \$!/);
});

test('buildRemoteSpawnCommand injects CORTEX_CLIENT_TOKEN on Windows remotes when given a token', () => {
  const cmd = buildRemoteSpawnCommand({ cortexPath: 'D:\\x', gpuCount: 0, ssh: 'user@host', win: true }, 'sektok123');
  assert.match(cmd, /CORTEX_CLIENT_TOKEN=sektok123/);
  assert.match(cmd, /cmd\.exe \/c/);
  assert.match(cmd, /cortex-client/);
});

test('buildRemoteSpawnCommand omits the token env when none is provided (back-compat)', () => {
  const cmd = buildRemoteSpawnCommand({ cortexPath: '/home/x', gpuCount: 0, ssh: 'user@host' });
  assert.doesNotMatch(cmd, /CORTEX_CLIENT_TOKEN/);
  assert.match(cmd, /^nohup cortex-client/);
});

test('buildRemoteSpawnCommand wraps Windows cortex-client invocation with cmd.exe /c', () => {
  const cmd = buildRemoteSpawnCommand({ cortexPath: 'D:\\x', gpuCount: 0, ssh: 'user@host', win: true });
  // Must include the cmd.exe wrapper so PATH lookup resolves cortex-client.cmd.
  assert.match(cmd, /cmd\.exe \/c cortex-client/);
  // Must still be a PowerShell WMI Win32_Process.Create call (server-side parser
  // expects the ProcessId on stdout).
  assert.match(cmd, /Invoke-WmiMethod -Class Win32_Process -Name Create/);
  assert.match(cmd, /\.ProcessId/);
});

test('buildRemoteSpawnCommand uses nohup + echo $! on Linux remotes', () => {
  const cmd = buildRemoteSpawnCommand({ cortexPath: '/home/x', gpuCount: 0, ssh: 'user@host' });
  assert.match(cmd, /^nohup cortex-client/);
  assert.match(cmd, /echo \$!/);
});

// --- Configurable launch command (machines.json `clientCommand`) ---
// nvm/custom-PATH machines can't rely on a bare `cortex-client` over a non-login
// SSH shell. `clientCommand` overrides the launched command (e.g. `bash -lc cortex-client`
// loads the login profile so nvm puts node + cortex-client on PATH) while keeping the
// nohup/echo-$! (Linux) and cmd.exe-wrap WMI (Windows) machinery + token injection intact.
test('buildRemoteSpawnCommand uses reg.clientCommand over the default on Linux', () => {
  const cmd = buildRemoteSpawnCommand({ cortexPath: '/home/nvidia', gpuCount: 8, ssh: 'nvidia@server-nvidia', clientCommand: 'bash -lc cortex-client' }, 'sektok123');
  assert.match(cmd, /CORTEX_CLIENT_TOKEN='sektok123'/);
  assert.match(cmd, /nohup bash -lc cortex-client > \/dev\/null 2>&1 & echo \$!/);
  assert.doesNotMatch(cmd, /nohup cortex-client\b/); // bare default must be replaced
});

test('buildRemoteSpawnCommand uses reg.clientCommand over the default on Windows', () => {
  const cmd = buildRemoteSpawnCommand({ cortexPath: 'D:\\x', gpuCount: 0, ssh: 'user@host', win: true, clientCommand: 'my-cortex-client' }, 'sektok123');
  assert.match(cmd, /cmd\.exe \/c set CORTEX_CLIENT_TOKEN=sektok123 && my-cortex-client/);
  assert.match(cmd, /Invoke-WmiMethod -Class Win32_Process -Name Create/);
});

test('buildRemoteSpawnCommand falls back to cortex-client when clientCommand is blank', () => {
  const cmd = buildRemoteSpawnCommand({ cortexPath: '/home/x', gpuCount: 0, ssh: 'user@host', clientCommand: '   ' });
  assert.match(cmd, /^nohup cortex-client > \/dev\/null/);
});

test('buildRemoteInstallCommand defaults to bare npm install -g <tgz> when unset', () => {
  const cmd = buildRemoteInstallCommand({ cortexPath: '/home/x', gpuCount: 0, ssh: 'user@host' }, '/tmp/cortex-agent-client-2026.6.22.tgz');
  assert.equal(cmd, 'npm install -g /tmp/cortex-agent-client-2026.6.22.tgz');
});

test('buildRemoteInstallCommand substitutes the {tgz} placeholder in a custom command', () => {
  const cmd = buildRemoteInstallCommand(
    { cortexPath: '/home/fangxm', gpuCount: 2, ssh: 'fangxm@lab', installCommand: "bash -lc 'source ~/.nvm/nvm.sh && npm install -g {tgz}'" },
    '/tmp/cortex-agent-client-2026.6.22.tgz',
  );
  assert.equal(cmd, "bash -lc 'source ~/.nvm/nvm.sh && npm install -g /tmp/cortex-agent-client-2026.6.22.tgz'");
  assert.doesNotMatch(cmd, /\{tgz\}/);
});

test('buildRemoteInstallCommand replaces every {tgz} occurrence', () => {
  const cmd = buildRemoteInstallCommand(
    { cortexPath: '/home/x', gpuCount: 0, ssh: 'user@host', installCommand: 'echo {tgz} && npm install -g {tgz}' },
    '/tmp/c.tgz',
  );
  assert.equal(cmd, 'echo /tmp/c.tgz && npm install -g /tmp/c.tgz');
});

test('buildRemoteInstallCommand appends the tgz path when the template has no placeholder', () => {
  const cmd = buildRemoteInstallCommand(
    { cortexPath: '/home/x', gpuCount: 0, ssh: 'user@host', installCommand: '/home/x/.nvm/versions/node/v20.19.5/bin/npm install -g' },
    '/tmp/c.tgz',
  );
  assert.equal(cmd, '/home/x/.nvm/versions/node/v20.19.5/bin/npm install -g /tmp/c.tgz');
});

test('buildRemoteInstallCommand falls back to the default when installCommand is blank', () => {
  const cmd = buildRemoteInstallCommand({ cortexPath: '/home/x', gpuCount: 0, ssh: 'user@host', installCommand: '   ' }, '/tmp/c.tgz');
  assert.equal(cmd, 'npm install -g /tmp/c.tgz');
});

// --- Regression: when SSH spawn returns an unparseable PID (the live failure mode
//     on my-pc), `startRemoteClient` previously only logged a WARN and returned —
//     no retry was scheduled. Combined with the WMI bug above, this caused my-pc to
//     stay silently offline for 3 days. Fix: always schedule a retry on spawn failure.
test('startRemoteClient schedules a retry when remote returns empty PID', async (t) => {
  t.onTestFinished(() => _testReset());

  // Fake registry with one Windows device.
  _setMachineRegistryProviderForTesting(() => ({
    'fake-win': { cortexPath: 'D:\\x', gpuCount: 0, ssh: 'user@fake', win: true },
  }));
  // Fake sshExec that always returns empty (mimics WMI Path-Not-Found case).
  _setSshExecForTesting(async () => '');

  assert.equal(_getRestartTimerCount(), 0);
  await startRemoteClient('fake-win');
  assert.equal(_getRestartTimerCount(), 1, 'expected one pending restart timer after failed spawn');
});

test('startRemoteClient schedules a retry when SSH itself throws', async (t) => {
  t.onTestFinished(() => _testReset());

  _setMachineRegistryProviderForTesting(() => ({
    'fake-linux': { cortexPath: '/home/x', gpuCount: 0, ssh: 'user@fake' },
  }));
  _setSshExecForTesting(async () => { throw new Error('SSH error: Connection refused'); });

  assert.equal(_getRestartTimerCount(), 0);
  await startRemoteClient('fake-linux');
  assert.equal(_getRestartTimerCount(), 1, 'expected retry timer when SSH fails outright');
});

test('sendCommand rejects pending commands when stopClientManager is called mid-flight', async (t) => {
  const port = await findEphemeralPort();
  startClientManager(port);
  t.onTestFinished(() => stopClientManager());

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: authHeaders });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'hello', device: 'mock-device-2', platform: 'linux', capabilities: [] }));
  await waitFor(() => isDeviceOnline('mock-device-2'));

  // Issue a command that will never get a response (the fake client doesn't reply to `command` frames).
  const pending = sendCommand('mock-device-2', { action: 'bash', params: { cmd: 'sleep 9999' }, timeout: 60_000 });
  // Swallow the expected rejection so Node doesn't flag it as unhandled.
  const rejection = pending.catch((err: Error) => err);

  // Yield once so the send goes through before we stop.
  await new Promise((r) => setImmediate(r));

  stopClientManager();
  const err = await rejection;
  assert.ok(err instanceof Error);
  assert.match(err.message, /shutting down|disconnected|not online/);

  try { ws.close(); } catch {}
});
