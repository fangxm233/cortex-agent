import { afterAll, beforeAll, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { parse } from 'yaml';

const home = process.env.CORTEX_HOME!;
const gatewayHome = path.join(home, 'gateway-home');
const url = 'http://127.0.0.1:17380';
const configPath = path.join(gatewayHome, '.aistatus/gateway.yaml');

beforeAll(() => {
  fs.writeFileSync(path.join(home, 'config/.env'), `CORTEX_GATEWAY_PORT=17380\nCORTEX_GATEWAY_HOME=${gatewayHome}\n`);
  vi.resetModules();
});
afterAll(() => vi.restoreAllMocks());

test('generation and sharing settings use the private gateway home', async () => {
  const generator = await import('../src/core/gateway-generator.js');
  assert.equal(parse(generator.generateGatewayYaml([])).port, 17380);
  assert.equal(generator.writeMergedGatewayYaml([]).path, configPath);
  assert.equal(generator.mergeGatewayConfig([], { top: { port: 9880 }, endpoints: {} }).top.port, 17380);
  assert.equal(parse(fs.readFileSync(configPath, 'utf8')).port, 17380);
  const sharing = await import('../src/domain/costs/aistatus-config.js');
  sharing.writeUsageSharing({ enabled: false });
  assert.equal(sharing.readUsageSharing().enabled, false);
  assert(fs.existsSync(path.join(gatewayHome, '.aistatus/config.yaml')));
});

function mockHttp(urls: string[]) {
  return (address: string, _options: unknown, callback: (res: unknown) => void) => {
    urls.push(address);
    const req = Object.assign(new EventEmitter(), { destroy() {} });
    queueMicrotask(() => {
      const res = Object.assign(new EventEmitter(), { statusCode: 503, resume() {} });
      callback(res);
      res.emit('end');
    });
    return req;
  };
}

test('manager health, spawn port/config and child HOME agree', async () => {
  const urls: string[] = [];
  const child = Object.assign(new EventEmitter(), { pid: 4321, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { child.emit('exit', 0, null); return true; } });
  const spawn = vi.fn(() => child);
  const globals = globalThis as typeof globalThis & { __mockHttpGet?: unknown; __mockChildProcessSpawn?: unknown };
  globals.__mockHttpGet = mockHttp(urls);
  globals.__mockChildProcessSpawn = spawn;
  const manager = await import('../src/domain/costs/gateway-manager.js');
  const { gatewayUrl } = await import('../src/core/gateway-endpoint.js');
  try {
    await manager.startGateway();
    assert.deepEqual(urls, [], 'no listener on the port is probed or adopted');
    assert.equal(gatewayUrl(), url);
    const call = spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    assert.deepEqual(call[1].slice(1), ['start', '-c', configPath, '-p', '17380', '--pid-file', path.join(home, 'data/gateway.pid')]);
    assert.equal(call[2].env.HOME, gatewayHome);
    assert.equal(call[2].env.USERPROFILE, gatewayHome);
    assert.equal(process.env.CORTEX_HOME, home);
  } finally {
    await manager.stopGateway();
    delete globals.__mockHttpGet;
    delete globals.__mockChildProcessSpawn;
  }
});

test('doctor probes and reports the configured endpoint and config path', async () => {
  const urls: string[] = [];
  vi.doMock('node:http', async (original) => ({ ...await original<object>(), get: mockHttp(urls) }));
  const { createDefaultDoctorDeps, runDiagnostics } = await import('../src/domain/system/doctor.js');
  const deps = createDefaultDoctorDeps();
  assert.equal(deps.aistatusDir, path.dirname(configPath));
  assert.equal(deps.gatewayUrl, url);
  await deps.probeGateway();
  assert.deepEqual(urls, [`${url}/status`]);
  deps.probeGateway = async () => true;
  deps.loadPiRuntime = async () => ({ available: false, version: null, entry: null, error: 'fixture', runtime: null, readStoredCredential: null });
  deps.getAuthStatus = async () => ({ generatedAt: '', accounts: [], piRuntime: { available: false, version: null, entry: null, error: 'fixture' } });
  const report = await runDiagnostics(deps);
  assert(report.sections.flatMap(s => s.checks).some(c => c.id === 'gateway-health' && c.detail.includes('17380')));
});

test('UsageService reads usage from the configured gateway URL', async () => {
  const { UsageService } = await import('../src/domain/costs/usage-service.js');
  const urls: string[] = [];
  const service = new UsageService({
    store: { list: async () => [], commit: async () => {} },
    getSettings: () => ({ anthropicSubscriptionModes: [], subscriptionBillingModes: [] }),
    fetch: (async (address: unknown) => { urls.push(String(address)); return new Response('{"rows":[]}'); }) as typeof fetch,
  });
  await service.collect();
  assert(urls.length >= 3);
  assert(urls.every(address => address.startsWith(`${url}/`)));
});
