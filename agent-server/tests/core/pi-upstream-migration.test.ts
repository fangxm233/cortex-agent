import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { parse as yamlParse } from 'yaml';

import {
  PI_PROVIDER_UPSTREAM,
  migrateRetiredPiUpstreams,
  refreshRetiredPiUpstreams,
  type EndpointMap,
} from '../../src/core/gateway-generator.js';
import { loadPiSdk } from '../../src/core/pi-sdk.js';

function tmpDir(): string {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'pi-upstream-'));
}

test('every PI upstream Cortex routes to is a base URL the pinned PI catalog still uses', async () => {
  const dir = tmpDir();
  const { ModelRuntime } = await loadPiSdk();
  const runtime = await ModelRuntime.create({
    authPath: nodePath.join(dir, 'auth.json'),
    modelsPath: nodePath.join(dir, 'models.json'),
    allowModelNetwork: false,
  });
  let checked = 0;
  for (const [provider, { url }] of Object.entries(PI_PROVIDER_UPSTREAM)) {
    const baseUrls = new Set(runtime.getModels(provider).map((model) => model.baseUrl));
    if (baseUrls.size === 0) continue;
    checked += 1;
    assert.ok(baseUrls.has(url), `${provider}: ${url} not in PI catalog ${[...baseUrls].join(', ')}`);
  }
  assert.ok(checked >= 15, `only ${checked} providers found in the PI catalog`);
});

test('refreshRetiredPiUpstreams moves stock routes and leaves relays and other providers alone', () => {
  const endpoints: EndpointMap = {
    'kimi-coding': { 'kimi-coding': { base_url: 'https://api.kimi.com/coding', auth_style: 'bearer' } },
    opencode: {
      opencode: { base_url: 'https://opencode.ai/zen', auth_style: 'bearer' },
      relay: { base_url: 'https://relay.example/opencode', auth_style: 'bearer', keys: ['k'] },
    },
    'opencode-go': { 'opencode-go': { base_url: 'https://opencode.ai/zen/go/v1', auth_style: 'bearer' } },
    deepseek: { deepseek: { base_url: 'https://api.deepseek.com', auth_style: 'bearer' } },
  };

  assert.equal(refreshRetiredPiUpstreams(endpoints), 3);
  assert.equal(endpoints['kimi-coding']['kimi-coding'].base_url, 'https://api.kimi.com/coding/v1');
  assert.equal(endpoints.opencode.opencode.base_url, 'https://opencode.ai/inference');
  assert.equal(endpoints.opencode.relay.base_url, 'https://relay.example/opencode');
  assert.deepEqual(endpoints.opencode.relay.keys, ['k']);
  assert.equal(endpoints['opencode-go']['opencode-go'].base_url, 'https://opencode.ai/inference/go/v1');
  assert.equal(endpoints.deepseek.deepseek.base_url, 'https://api.deepseek.com');
});

test('migrateRetiredPiUpstreams rewrites gateway.yaml once and keeps its other settings', () => {
  const file = nodePath.join(tmpDir(), 'gateway.yaml');
  fs.writeFileSync(file, [
    'port: 9881',
    'mode: kimi-coding',
    'kimi-coding:',
    '  kimi-coding:',
    '    base_url: https://api.kimi.com/coding',
    '    auth_style: bearer',
    'deepseek:',
    '  deepseek:',
    '    base_url: https://relay.example/deepseek',
    '    auth_style: bearer',
    '',
  ].join('\n'));

  assert.equal(migrateRetiredPiUpstreams(file), 1);
  const doc = yamlParse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.port, 9881);
  assert.equal(doc.mode, 'kimi-coding');
  assert.equal(doc['kimi-coding']['kimi-coding'].base_url, 'https://api.kimi.com/coding/v1');
  assert.equal(doc.deepseek.deepseek.base_url, 'https://relay.example/deepseek');
  assert.ok(fs.existsSync(`${file}.bak`));

  const migrated = fs.readFileSync(file, 'utf8');
  assert.equal(migrateRetiredPiUpstreams(file), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), migrated);
});

test('migrateRetiredPiUpstreams ignores a missing gateway.yaml', () => {
  assert.equal(migrateRetiredPiUpstreams(nodePath.join(tmpDir(), 'gateway.yaml')), 0);
});
