import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { CONFIG_DIR } from '../../src/core/paths.js';
import { modelsRepo } from '../../src/store/models-repo.js';
import {
  handleModelsFavoriteAdd, handleModelsFavoriteRemove, handleModelsSetDefault,
} from '../../src/domain/ui-service/mutate/models.js';
import type { UiServiceDeps } from '../../src/domain/ui-service/types.js';
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function pauseModelsRead() {
  const captured = deferred();
  const resume = deferred();
  const readFile = fsPromises.readFile;
  vi.spyOn(fsPromises, 'readFile').mockImplementationOnce(async file => {
    assert.equal(file, path.join(CONFIG_DIR, 'models.json'));
    const snapshot = await readFile(file, 'utf8');
    captured.resolve();
    await resume.promise;
    return snapshot;
  });
  return { captured: captured.promise, resume: resume.resolve };
}

const deps = {} as UiServiceDeps;
const sonnet = { backend: 'claude' as const, provider: null, model: 'sonnet' };
const nextDefault = { ...sonnet, mode: 'plan', thinking: 'high' as const };
const mutations = [
  { name: 'add favorite', run: () => handleModelsFavoriteAdd(deps, sonnet), favorites: [favorite, sonnet], selection: existing },
  { name: 'remove favorite', run: () => handleModelsFavoriteRemove(deps, sonnet), favorites: [favorite], selection: existing },
  { name: 'set default', run: () => handleModelsSetDefault(deps, { selection: nextDefault }), favorites: [favorite, sonnet], selection: nextDefault },
];

for (const mutation of mutations) {
  test(`UI ${mutation.name} and login sync serialize their full models transactions`, async () => {
    const dirs = { ...makeDirs(), configDir: CONFIG_DIR };
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    save(CONFIG_DIR, { default: existing, favorites: [favorite, ...(mutation.name === 'add favorite' ? [] : [sonnet])] });
    const invalidate = vi.spyOn(modelsRepo, 'invalidate');
    const pause = pauseModelsRead();
    const ui = mutation.run();
    await pause.captured;
    let syncFinished = false;
    const sync = syncGatewayFromBackends({ ...dirs, discover: () => [piEndpoint('acme', ['large'])] })
      .then(result => { syncFinished = true; return result; });
    // Sync discovery and its synchronous transaction can finish in this turn unless locked.
    await new Promise<void>(resolve => setImmediate(resolve));
    const finishedWhileUiPaused = syncFinished;
    pause.resume();
    const [uiResult, syncResult] = await Promise.all([ui, sync]);
    assert.equal(finishedWhileUiPaused, false, 'login sync must wait for the UI snapshot to be committed');
    assert.deepEqual(uiResult, { ok: true, data: { changed: true } });
    assert.equal(syncResult.configured, true);
    const favorites = [...mutation.favorites, { backend: 'pi', provider: 'acme', model: 'large' }];
    assert.deepEqual(load(CONFIG_DIR), { default: mutation.selection, favorites });
    assert.deepEqual(syncResult.favorites, favorites);
    assert.equal(invalidate.mock.calls.length, 2, 'both writes invalidate before releasing the lock');
  });
}
