import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadGatewayConfig, resolveGatewayConfig, gatewayYamlPort } from '../../src/core/gateway-config.js';

const home = path.join(os.tmpdir(), 'gateway-user');
const privateHome = path.join(home, 'private');

test('unset gateway settings preserve the legacy endpoint, paths and YAML merge', () => {
  const config = resolveGatewayConfig({}, {}, home);
  assert.equal(config.port, 9880);
  assert.equal(config.url, 'http://127.0.0.1:9880');
  assert.equal(config.home, undefined);
  assert.equal(config.aistatusDir, path.join(home, '.aistatus'));
  assert.equal(config.configPath, path.join(home, '.aistatus/gateway.yaml'));
  assert.equal(gatewayYamlPort(config), 9880);
  assert.equal(gatewayYamlPort(config, 9991), 9991);
});

test('process environment overrides the instance dotenv settings', () => {
  const file = { CORTEX_GATEWAY_PORT: '17380', CORTEX_GATEWAY_HOME: privateHome };
  const config = resolveGatewayConfig({ CORTEX_GATEWAY_PORT: '17381' }, file, home);
  assert.equal(config.port, 17381);
  assert.equal(config.url, 'http://127.0.0.1:17381');
  assert.equal(config.home, privateHome);
  assert.equal(config.configPath, path.join(privateHome, '.aistatus/gateway.yaml'));
  assert.equal(gatewayYamlPort(config, 9880), 17381);
});

test('explicit gateway settings are validated rather than falling back to live defaults', () => {
  for (const port of ['', ' ', '0', '-1', '65536', '1.5', 'NaN', '9880x', '1e4', '0x2698']) {
    assert.throws(() => resolveGatewayConfig({ CORTEX_GATEWAY_PORT: port }, {}, home), /CORTEX_GATEWAY_PORT/);
  }
  for (const value of ['', ' ', 'relative', '~/gateway']) {
    assert.throws(() => resolveGatewayConfig({ CORTEX_GATEWAY_HOME: value }, {}, home), /CORTEX_GATEWAY_HOME/);
  }
  for (const port of ['1', '65535', ' 17380 ']) {
    assert.equal(resolveGatewayConfig({ CORTEX_GATEWAY_PORT: port }, {}, home).port, Number(port));
  }
});

test('CLI resolves gateway dotenv without mutating process environment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-config-'));
  fs.writeFileSync(path.join(dir, '.env'), `CORTEX_GATEWAY_PORT=17380\nCORTEX_GATEWAY_HOME="${privateHome.replaceAll('\\', '/')}"\n`);
  const env = {};
  assert.equal(loadGatewayConfig(dir, env, home).port, 17380);
  assert.deepEqual(env, {});
  assert.equal(loadGatewayConfig(path.join(dir, 'absent'), {}, home).port, 9880);
});
