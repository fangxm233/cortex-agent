import { afterAll, beforeAll, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
