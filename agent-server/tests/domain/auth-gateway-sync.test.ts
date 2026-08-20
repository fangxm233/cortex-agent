// input:  gateway sync service, stub endpoint discovery, temporary config dirs
// output: verification that a login refreshes gateway.yaml and profiles.json
// pos:    Post-login model routing sync tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

import { syncGatewayFromBackends } from '../../src/domain/auth/gateway-sync.js';
import type { DiscoveredEndpoint } from '../../src/core/gateway-generator.js';

const tempDirs: string[] = [];

function makeDirs(): { configDir: string; gatewayConfigDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-gateway-sync-'));
  tempDirs.push(root);
  const configDir = path.join(root, 'config');
  const gatewayConfigDir = path.join(root, 'aistatus');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(gatewayConfigDir, { recursive: true });
  return { configDir, gatewayConfigDir };
}

function piEndpoint(mode: string, models: string[]): DiscoveredEndpoint {
  return {
    mode,
    endpoint: mode,
    base_url: 'https://api.example.com',
    auth_style: 'bearer',
    keys: [],
    passthrough: true,
    models,
    gatewayManaged: true,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

test('a login that reveals new endpoints writes gateway.yaml and profiles.json', async () => {
  const { configDir, gatewayConfigDir } = makeDirs();

  const result = await syncGatewayFromBackends({
    configDir,
    gatewayConfigDir,
    discover: () => [piEndpoint('acme', ['acme-large', 'acme-small'])],
  });

  assert.equal(result.configured, true);
  assert.equal(result.endpoints, 1);
  assert.ok(result.profiles.includes('plan'));
  assert.ok(result.profiles.includes('execute'));

  assert.ok(fs.existsSync(path.join(gatewayConfigDir, 'gateway.yaml')));
  const profiles = JSON.parse(fs.readFileSync(path.join(configDir, 'profiles.json'), 'utf-8'));
  assert.equal(profiles.profiles.plan.model, 'acme-large');
});

test('sync preserves a profile the operator already customised', async () => {
  const { configDir, gatewayConfigDir } = makeDirs();
  fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
    defaultProfile: 'plan',
    profiles: { plan: { backend: 'pi', mode: 'handpicked', model: 'my-model' } },
  }, null, 2));

  await syncGatewayFromBackends({
    configDir,
    gatewayConfigDir,
    discover: () => [piEndpoint('acme', ['acme-large'])],
  });

  const profiles = JSON.parse(fs.readFileSync(path.join(configDir, 'profiles.json'), 'utf-8'));
  assert.equal(profiles.profiles.plan.model, 'my-model', 'a hand-edited profile must survive a login');
  assert.ok(profiles.profiles.execute, 'a missing managed profile is still filled in');
});

test('sync reports no-endpoints instead of writing an empty config', async () => {
  const { configDir, gatewayConfigDir } = makeDirs();

  const result = await syncGatewayFromBackends({
    configDir,
    gatewayConfigDir,
    discover: () => [],
  });

  assert.equal(result.configured, false);
  assert.equal(result.reason, 'no-endpoints');
  assert.equal(fs.existsSync(path.join(configDir, 'profiles.json')), false);
});

test('sync never throws — a failing discovery is reported, not propagated', async () => {
  const { configDir, gatewayConfigDir } = makeDirs();

  const result = await syncGatewayFromBackends({
    configDir,
    gatewayConfigDir,
    discover: () => { throw new Error('pi --list-models exploded'); },
  });

  assert.equal(result.configured, false);
  assert.match(String(result.reason), /exploded/);
});

test('sync passes the backend filter through to discovery', async () => {
  const { configDir, gatewayConfigDir } = makeDirs();
  const seen: Array<string[] | undefined> = [];

  await syncGatewayFromBackends({
    configDir,
    gatewayConfigDir,
    backends: ['pi'],
    discover: (backends) => { seen.push(backends); return [piEndpoint('acme', ['acme-large'])]; },
  });

  assert.deepEqual(seen, [['pi']]);
});
