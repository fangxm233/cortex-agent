import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { requestLoopbackJson } from '../../../src/core/loopback-http.js';
import { CONFIG_DIR } from '../../../src/core/paths.js';
import { registerRemoteOpsTools } from '../../../src/domain/mcp/tools/remote-ops.js';
import { toolContextFromEnv } from '../../../src/domain/mcp/tools/context.js';
import {
  describeDeviceCatalog,
  readKnownDevices,
  withOnlineDevices,
} from '../../../src/domain/mcp/tools/remote-devices.js';

vi.mock('../../../src/core/loopback-http.js', () => ({ requestLoopbackJson: vi.fn() }));
const requestMock = vi.mocked(requestLoopbackJson);
const ctx = toolContextFromEnv({ WEBHOOK_PORT: '4321', CORTEX_WEBHOOK_TOKEN: 'unit-token' });
const MACHINES_FILE = path.join(CONFIG_DIR, 'machines.json');
const REMOTE_TOOLS = ['remote_bash', 'remote_read', 'remote_write', 'remote_edit', 'remote_glob', 'remote_grep'];

function writeMachines(machines: Record<string, unknown>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(MACHINES_FILE, JSON.stringify(machines));
}

function captureRemoteTools(): Map<string, any[]> {
  const tools = new Map<string, any[]>();
  registerRemoteOpsTools({ tool: (...args: any[]) => tools.set(args[0], args) } as any, ctx);
  return tools;
}

afterEach(() => {
  requestMock.mockReset();
  fs.rmSync(MACHINES_FILE, { force: true });
});

test('readKnownDevices lists every registered machine and flags Windows ones', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devices-')), 'machines.json');
  fs.writeFileSync(file, JSON.stringify({ lab2: { cortexPath: '/a', gpuCount: 2 }, 'my-pc': { cortexPath: 'D:\\', gpuCount: 1, win: true } }));

  assert.deepEqual(readKnownDevices(file), [
    { name: 'lab2', windows: false },
    { name: 'my-pc', windows: true },
  ]);
});

test('readKnownDevices returns nothing for a missing or malformed file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devices-'));
  assert.deepEqual(readKnownDevices(path.join(dir, 'absent.json')), []);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  assert.deepEqual(readKnownDevices(path.join(dir, 'bad.json')), []);
});

test('describeDeviceCatalog names known devices and drops placeholder examples', () => {
  const text = describeDeviceCatalog([{ name: 'lab2', windows: false }, { name: 'my-pc', windows: true }]);
  assert.match(text, /lab2, my-pc \(Windows\)/);
  assert.match(text, /offline/);
  assert.doesNotMatch(describeDeviceCatalog([]), /Known devices/);
});

test('withOnlineDevices appends the online list, or says none are online', () => {
  assert.equal(withOnlineDevices('Device "x" is not online', ['lab2', 'lab']), 'Device "x" is not online. Online devices: lab2, lab');
  assert.equal(withOnlineDevices('Device "x" is not online', []), 'Device "x" is not online. Online devices: none');
  assert.equal(withOnlineDevices('Command failed', undefined), 'Command failed');
});

test('one remote description lists devices, online or not; parameters stay short', () => {
  writeMachines({ lab2: { cortexPath: '/a', gpuCount: 2 }, laptop: { cortexPath: 'C:\\', gpuCount: 0, win: true } });
  const tools = captureRemoteTools();

  for (const name of REMOTE_TOOLS) {
    const description = tools.get(name)![2].device.description as string;
    assert.equal(description, 'Target device name.', name);
    const toolDescription = tools.get(name)![1] as string;
    assert.equal(toolDescription.includes('lab2, laptop (Windows)'), name === 'remote_bash');
  }
});

test('a call to an offline device reports the devices that are online', async () => {
  requestMock.mockResolvedValue({
    status: 200,
    body: { success: false, error: 'Device "laptop" is not online', onlineDevices: ['lab2', 'lab-ksu'] },
  });
  const handler = captureRemoteTools().get('remote_bash')!.at(-1);

  const result = await handler({ device: 'laptop', command: 'true' }, {});

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'remote_bash error: Device "laptop" is not online. Online devices: lab2, lab-ksu');
});
