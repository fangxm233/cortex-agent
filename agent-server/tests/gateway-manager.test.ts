import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { spawn as spawnReal, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { parse } from 'dotenv';
import { parse as parseYaml } from 'yaml';

const home = process.env.CORTEX_HOME!;
const envFile = path.join(home, 'config/.env');
const gatewayHome = path.join(home, 'gateway-home');
const pidFile = path.join(home, 'data/gateway.pid');
const globals = globalThis as typeof globalThis & { __mockHttpGet?: unknown; __mockChildProcessSpawn?: unknown };

type FakeChild = EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
type Manager = typeof import('../src/domain/costs/gateway-manager.js');

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  delete process.env.CORTEX_GATEWAY_PORT;
  delete globals.__mockHttpGet;
  delete globals.__mockChildProcessSpawn;
});

function fakeChild(): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill() { child.emit('exit', null, 'SIGTERM'); return true; },
  });
  return child;
}

function unhealthyHttpGet(_url: string, _options: unknown, callback: (res: unknown) => void) {
  const req = Object.assign(new EventEmitter(), { destroy() {} });
  queueMicrotask(() => {
    const res = Object.assign(new EventEmitter(), { statusCode: 503, resume() {} });
    callback(res);
    res.emit('end');
  });
  return req;
}

/** A loopback server the test owns; resolves once it listens. */
async function occupy(port = 0, handler?: http.RequestListener): Promise<number> {
  const server = handler ? http.createServer(handler) : net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1' }, () => resolve());
  });
  cleanups.push(() => new Promise(resolve => server.close(resolve)));
  return (server.address() as net.AddressInfo).port;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen({ port: 0, host: '127.0.0.1' }, () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function savedEnv(): Record<string, string> {
  return parse(fs.readFileSync(envFile, 'utf8'));
}

/** Fresh module graph so paths.ts and the gateway endpoint read this test's settings. */
async function loadManager(envLines: string[]) {
  fs.mkdirSync(path.join(gatewayHome, '.aistatus'), { recursive: true });
  fs.writeFileSync(envFile, [...envLines, `CORTEX_GATEWAY_HOME=${gatewayHome}`, ''].join('\n'));
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => { const child = fakeChild(); children.push(child); return child; });
  globals.__mockChildProcessSpawn = spawn;
  globals.__mockHttpGet = unhealthyHttpGet;
  vi.resetModules();
  const manager: Manager = await import('../src/domain/costs/gateway-manager.js');
  const endpoint = await import('../src/core/gateway-endpoint.js');
  cleanups.push(() => manager.stopGateway());
  const portArgs = () => spawn.mock.calls.map(call => {
    const args = (call as unknown as [string, string[]])[1];
    return Number(args[args.indexOf('-p') + 1]);
  });
  return { manager, endpoint, spawn, children, portArgs };
}

test('a free configured port: the gateway launches there with this instance\'s pid file', async () => {
  const port = await freePort();
  const { manager, endpoint, spawn, portArgs } = await loadManager([`CORTEX_GATEWAY_PORT=${port}`]);

  await manager.startGateway();

  assert.deepEqual(portArgs(), [port]);
  const args = (spawn.mock.calls[0] as unknown as [string, string[]])[1];
  assert.deepEqual(args.slice(-2), ['--pid-file', pidFile]);
  assert.equal(endpoint.gatewayUrl(), `http://127.0.0.1:${port}`);
  assert.equal(savedEnv().CORTEX_GATEWAY_PORT, String(port), 'an unmoved port leaves config/.env as it was');
});

test('a healthy foreign gateway on the configured port is never adopted: the gateway moves and saves the port', async () => {
  const statusHits: string[] = [];
  const taken = await occupy(0, (req, res) => { statusHits.push(req.url ?? ''); res.writeHead(200).end('{"ok":true}'); });
  fs.mkdirSync(path.join(gatewayHome, '.aistatus'), { recursive: true });
  const yamlPath = path.join(gatewayHome, '.aistatus/gateway.yaml');
  fs.writeFileSync(yamlPath, `# routes\nport: ${taken}\nmode: api\n`);
  const { manager, endpoint, spawn, portArgs } = await loadManager([`CORTEX_GATEWAY_PORT=${taken}`]);

  await manager.startGateway();

  assert.equal(spawn.mock.calls.length, 1, 'the manager launches its own gateway');
  const [moved] = portArgs();
  assert.notEqual(moved, taken);
  assert.equal(endpoint.gatewayUrl(), `http://127.0.0.1:${moved}`);
  assert.equal(savedEnv().CORTEX_GATEWAY_PORT, String(moved));
  assert.equal(fs.readFileSync(yamlPath, 'utf8'), `# routes\nport: ${moved}\nmode: api\n`);
  assert.deepEqual(statusHits, [], 'the foreign gateway is not even probed');
});

test('a stale process-env port falls back to the saved port without rewriting config/.env', async () => {
  const taken = await occupy();
  const saved = await freePort();
  process.env.CORTEX_GATEWAY_PORT = String(taken);
  const { manager, endpoint, portArgs } = await loadManager([`CORTEX_GATEWAY_PORT=${saved}`]);
  const before = fs.readFileSync(envFile, 'utf8');

  await manager.startGateway();

  assert.deepEqual(portArgs(), [saved]);
  assert.equal(endpoint.gatewayUrl(), `http://127.0.0.1:${saved}`);
  assert.equal(fs.readFileSync(envFile, 'utf8'), before);
  assert.equal(process.env.CORTEX_GATEWAY_PORT, String(saved), 'children inherit the port in use');
});

/** Stands in for a gateway an earlier, SIGKILLed server run left behind on `port`. */
async function startOrphan(port: number): Promise<ChildProcess> {
  const script = `require('net').createServer().listen(${port}, '127.0.0.1', () => console.log('ready'))`;
  const orphan = spawnReal(process.execPath, ['-e', script, 'gateway-cli.js', '--pid-file', pidFile], { stdio: ['ignore', 'pipe', 'ignore'] });
  cleanups.push(() => { if (orphan.exitCode === null && orphan.signalCode === null) orphan.kill('SIGKILL'); });
  await new Promise<void>((resolve, reject) => {
    orphan.stdout!.once('data', () => resolve());
    orphan.once('exit', () => reject(new Error('orphan stand-in exited early')));
  });
  fs.writeFileSync(pidFile, String(orphan.pid));
  return orphan;
}

test('this instance\'s orphaned gateway is stopped and the gateway relaunches on the same port', async () => {
  const port = await freePort();
  const orphan = await startOrphan(port);
  const exited = new Promise(resolve => orphan.once('exit', resolve));
  const { manager, endpoint, portArgs } = await loadManager([`CORTEX_GATEWAY_PORT=${port}`]);

  await manager.startGateway();

  await exited;
  assert.deepEqual(portArgs(), [port]);
  assert.equal(endpoint.gatewayUrl(), `http://127.0.0.1:${port}`);
  assert.equal(savedEnv().CORTEX_GATEWAY_PORT, String(port));
});

test('a recycled pid in the pid file is left alone and treated as a foreign port holder', async () => {
  const taken = await occupy();
  const bystander = spawnReal(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  cleanups.push(() => { bystander.kill('SIGKILL'); });
  fs.writeFileSync(pidFile, String(bystander.pid));
  const { manager, portArgs } = await loadManager([`CORTEX_GATEWAY_PORT=${taken}`]);

  await manager.startGateway();

  assert.equal(bystander.exitCode, null);
  assert.equal(bystander.signalCode, null);
  assert.notEqual(portArgs()[0], taken);
});

test('a crash restart reuses the port chosen at startup', async () => {
  const port = await freePort();
  const { manager, children, portArgs } = await loadManager([`CORTEX_GATEWAY_PORT=${port}`]);
  await manager.startGateway();
  // Re-choosing now would move the gateway; sessions already hold the old URL.
  await occupy(port);

  children[0].emit('exit', 1, null);
  await vi.waitFor(() => assert.equal(portArgs().length, 2), { timeout: 3_000, interval: 50 });

  assert.deepEqual(portArgs(), [port, port]);
});

test('consumers loaded before a move read the moved URL, and a fresh process reads it from config/.env', async () => {
  const taken = await occupy();
  const { manager, portArgs } = await loadManager([`CORTEX_GATEWAY_PORT=${taken}`]);
  const { resolveModeEnv } = await import('../src/domain/runs/mode-env.js');
  const { specFromFixture } = await import('./run-request-fixture.js');
  const { UsageService } = await import('../src/domain/costs/usage-service.js');
  const fetched: string[] = [];
  const usage = new UsageService({
    store: { list: async () => [], commit: async () => {} },
    getSettings: () => ({ anthropicSubscriptionModes: [], subscriptionBillingModes: [] }),
    fetch: (async (address: unknown) => { fetched.push(String(address)); return new Response('{"rows":[]}'); }) as typeof fetch,
  });

  await manager.startGateway();
  const [port] = portArgs();
  const moved = `http://127.0.0.1:${port}`;
  assert.notEqual(port, taken);

  manager._testSetHealthy(true);
  cleanups.push(() => manager._testSetHealthy(null));
  assert.equal(resolveModeEnv('api').ANTHROPIC_BASE_URL, `${moved}/m/api/anthropic`);
  const pi = specFromFixture({}, { backend: 'pi', provider: 'deepseek', model: 'fixture', mode: 'api' });
  assert.equal(pi.route.gatewayBaseUrl, moved);
  await usage.collect();
  assert(fetched.length > 0 && fetched.every(address => address.startsWith(`${moved}/`)));
  const { defaultCustomProviderStores } = await import('../src/domain/pi-providers/custom-provider-service.js');
  assert.equal(defaultCustomProviderStores().gatewayUrl, moved);
  const { generateGatewayYaml } = await import('../src/core/gateway-generator.js');
  assert.equal(parseYaml(generateGatewayYaml([])).port, port);

  vi.resetModules();
  const { createDefaultDoctorDeps } = await import('../src/domain/system/doctor.js');
  assert.equal(createDefaultDoctorDeps().gatewayUrl, moved, 'a CLI process finds the saved port');
});
