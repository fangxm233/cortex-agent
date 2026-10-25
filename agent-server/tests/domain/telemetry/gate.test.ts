import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import { evaluateTelemetryGate, type TelemetryGateInput } from '@domain/telemetry/gate.js';
import { resolveTelemetryEndpoint } from '@domain/telemetry/endpoint.js';
import { parseClientKind } from '@domain/telemetry/client-kind.js';

const ENDPOINT = 'https://telemetry.example.com/v1/batch';

function gate(overrides: Partial<TelemetryGateInput> = {}) {
  return evaluateTelemetryGate({
    settingEnabled: true, env: {}, devCheckout: false, endpoint: ENDPOINT, ...overrides,
  });
}

test('an enabled release install with an endpoint is active on the release channel', () => {
  assert.deepEqual(gate(), { active: true, reason: null, channel: 'release', endpoint: ENDPOINT });
});

test('the saved setting turns telemetry off', () => {
  assert.equal(gate({ settingEnabled: false }).reason, 'setting');
});

test('CORTEX_TELEMETRY=0 wins over an enabled setting', () => {
  const result = gate({ env: { CORTEX_TELEMETRY: '0' } });
  assert.equal(result.active, false);
  assert.equal(result.reason, 'env');
});

test('DO_NOT_TRACK forces telemetry off for any truthy value', () => {
  for (const value of ['1', 'true', 'yes']) {
    assert.equal(gate({ env: { DO_NOT_TRACK: value } }).reason, 'do-not-track');
  }
  for (const value of ['0', '', 'false']) {
    assert.equal(gate({ env: { DO_NOT_TRACK: value } }).active, true);
  }
});

test('a sealed home never sends', () => {
  assert.equal(gate({ env: { CORTEX_CONFIG_IMMUTABLE: '1' } }).reason, 'sealed');
  assert.equal(gate({ env: { CORTEX_CONFIG_IMMUTABLE: '1', CORTEX_TELEMETRY: '1' } }).reason, 'sealed');
});

test('a dev checkout is off unless CORTEX_TELEMETRY=1, which marks it dev', () => {
  assert.equal(gate({ devCheckout: true }).reason, 'dev');
  const optedIn = gate({ devCheckout: true, env: { CORTEX_TELEMETRY: '1' } });
  assert.equal(optedIn.active, true);
  assert.equal(optedIn.channel, 'dev');
});

test('no endpoint means nothing is sent', () => {
  assert.equal(gate({ endpoint: null }).reason, 'no-endpoint');
});

test('the endpoint comes from the env override, then from build-info.json', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'telemetry-endpoint-'));
  const info = path.join(dir, 'build-info.json');
  assert.equal(resolveTelemetryEndpoint({}, info), null);
  writeFileSync(info, JSON.stringify({ telemetryEndpoint: ENDPOINT }));
  assert.equal(resolveTelemetryEndpoint({}, info), ENDPOINT);
  assert.equal(
    resolveTelemetryEndpoint({ CORTEX_TELEMETRY_ENDPOINT: 'http://127.0.0.1:9/x' }, info),
    'http://127.0.0.1:9/x',
  );
  writeFileSync(info, JSON.stringify({ telemetryEndpoint: 'ftp://nope' }));
  assert.equal(resolveTelemetryEndpoint({}, info), null);
});

test('the client header is parsed case-insensitively and unknown values are dropped', () => {
  assert.equal(parseClientKind('Desktop'), 'desktop');
  assert.equal(parseClientKind(['android']), 'android');
  assert.equal(parseClientKind('tv'), null);
  assert.equal(parseClientKind(undefined), null);
});
