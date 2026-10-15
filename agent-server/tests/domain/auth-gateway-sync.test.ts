import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { syncGatewayFromBackends } from '../../src/domain/auth/gateway-sync.js';
import type { DiscoveredEndpoint } from '../../src/core/gateway-generator.js';
const tempDirs: string[] = [];
function makeDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-gateway-sync-'));
  tempDirs.push(root);
  const configDir = path.join(root, 'config');
  const gatewayConfigDir = path.join(root, 'aistatus');
  fs.mkdirSync(configDir); fs.mkdirSync(gatewayConfigDir);
  return { configDir, gatewayConfigDir };
}
function piEndpoint(mode: string, models: string[]): DiscoveredEndpoint {
  return { mode, endpoint: mode, base_url: 'https://api.example.com', auth_style: 'bearer', keys: [], passthrough: true, models, gatewayManaged: true };
}
afterEach(() => { while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true }); });
const existing = { backend: 'claude', provider: null, mode: 'plan', model: 'opus', thinking: 'high' };
const favorite = { backend: 'claude', provider: null, model: 'opus' };
function save(configDir: string, value: unknown) { fs.writeFileSync(path.join(configDir, 'models.json'), JSON.stringify(value)); }
function load(configDir: string) { return JSON.parse(fs.readFileSync(path.join(configDir, 'models.json'), 'utf8')); }

test('first login writes gateway and a recommended default with favorites', async () => {
  const dirs = makeDirs();
  const result = await syncGatewayFromBackends({ ...dirs, discover: () => [piEndpoint('acme', ['large', 'small'])] });
  assert.equal(result.configured, true);
  assert.equal(result.endpoints, 1);
  assert.equal(result.defaultSet, true);
  assert.deepEqual(result.favorites, [{ backend: 'pi', provider: 'acme', model: 'large' }]);
  assert.ok(fs.existsSync(path.join(dirs.gatewayConfigDir, 'gateway.yaml')));
  assert.equal(load(dirs.configDir).default.model, 'large');
});
test('login preserves customized default and adds each newly connected backend/provider once', async () => {
  const dirs = makeDirs();
  save(dirs.configDir, { default: existing, favorites: [favorite] });
  const sync = () => syncGatewayFromBackends({ ...dirs, backends: ['pi'], discover: () => [piEndpoint('acme', ['large']), piEndpoint('other', ['org/model.v1'])] });
  assert.equal((await sync()).defaultSet, false);
  await sync();
  const saved = load(dirs.configDir);
  assert.deepEqual(saved.default, existing);
  assert.deepEqual(saved.favorites, [favorite, { backend: 'pi', provider: 'acme', model: 'large' }, { backend: 'pi', provider: 'other', model: 'org/model.v1' }]);
});
test('a group already favorited does not gain the newly recommended model', async () => {
  const dirs = makeDirs();
  save(dirs.configDir, { default: existing, favorites: [{ backend: 'pi', provider: 'acme', model: 'custom' }] });
  await syncGatewayFromBackends({ ...dirs, discover: () => [piEndpoint('acme', ['large'])] });
  assert.equal(load(dirs.configDir).favorites.length, 1);
});
test('default-less config gets a default while preserving favorites', async () => {
  const dirs = makeDirs();
  save(dirs.configDir, { favorites: [favorite] });
  const result = await syncGatewayFromBackends({ ...dirs, discover: () => [piEndpoint('acme', ['large'])] });
  assert.equal(result.defaultSet, true);
  assert.equal(load(dirs.configDir).default.model, 'large');
  assert.equal(result.favorites.length, 2);
});
test('no endpoints or model-less endpoints do not write an empty config', async () => {
  const dirs = makeDirs();
  for (const endpoints of [[], [piEndpoint('empty', [])]]) {
    const result = await syncGatewayFromBackends({ ...dirs, discover: () => endpoints });
    assert.equal(result.reason, 'no-endpoints');
    assert.equal(result.defaultSet, false);
  }
  assert.equal(fs.existsSync(path.join(dirs.configDir, 'models.json')), false);
});
test('discovery failures do not fail login', async () => {
  const result = await syncGatewayFromBackends({ ...makeDirs(), discover: () => { throw new Error('discovery exploded'); } });
  assert.equal(result.configured, false);
  assert.match(result.reason!, /exploded/);
});
