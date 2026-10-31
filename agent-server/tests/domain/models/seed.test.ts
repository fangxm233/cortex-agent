import { afterEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('@core/log.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import type { ConnectionView } from '../../../src/domain/connections/inventory.js';
import { createModelCatalog, type ModelCatalog } from '../../../src/domain/models/catalog.js';
import { seedModelsFromCatalog, type ModelSeedOptions } from '../../../src/domain/models/seed.js';
import type { PiDiscoveredModel } from '../../../src/agent-adapter/pi/discovery.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function configDir(models?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-model-seed-'));
  dirs.push(dir);
  if (models !== undefined) fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify(models));
  return dir;
}

const load = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));

function claudeView(id: string, models: string[] | null = null): ConnectionView {
  return {
    id, backend: 'claude', provider: null, kind: id === 'subscription' ? 'subscription' : 'key', label: id,
    baseUrl: null, billing: 'metered', authenticated: true, keyHint: null, models,
  };
}

interface Host { connections?: ConnectionView[]; pi?: PiDiscoveredModel[]; rescan?: () => Promise<PiDiscoveredModel[]> }

function hostCatalog(host: Host): ModelCatalog {
  const pi = host.pi ?? [];
  return createModelCatalog({
    connections: () => host.connections ?? [],
    claudeModels: { get: () => [], ensure: async () => [] },
    piModels: { peek: () => pi, ensure: async () => pi, ...(host.rescan ? { rescan: host.rescan } : {}) },
  });
}

function seed(dir: string, host: Host, options: Partial<ModelSeedOptions> = {}) {
  return seedModelsFromCatalog({
    configDir: dir, catalog: hostCatalog(host), connections: () => host.connections ?? [],
    piDefaults: async () => ({ acme: 'small' }), ...options,
  });
}

const ACME = [{ provider: 'acme', model: 'large' }, { provider: 'acme', model: 'small' }];
const EXISTING = { backend: 'claude', provider: null, connection: 'subscription', model: 'opus', thinking: 'high' };
const OPUS = { backend: 'claude', provider: null, model: 'opus' };

test('a first login writes the recommended default and one favorite per route', async () => {
  const dir = configDir();
  const result = await seed(dir, { connections: [claudeView('subscription')], pi: ACME });
  expect(result).toMatchObject({ configured: true, routes: 2, defaultSet: true });
  const saved = load(dir);
  // Claude's newest flagship comes first; PI's provider default beats its scan order.
  expect(saved.default).toEqual({ backend: 'claude', provider: null, model: 'claude-fable-5-1', thinking: null, connection: null });
  expect(saved.favorites).toEqual([
    { backend: 'claude', provider: null, model: 'claude-fable-5-1' },
    { backend: 'pi', provider: 'acme', model: 'small' },
  ]);
});

test('a login on one backend seeds only that backend and keeps the operator\'s default', async () => {
  const dir = configDir({ default: EXISTING, favorites: [OPUS] });
  const host = { connections: [claudeView('subscription')], pi: [...ACME, { provider: 'other', model: 'org/model.v1' }] };
  expect((await seed(dir, host, { backends: ['pi'] })).defaultSet).toBe(false);
  await seed(dir, host, { backends: ['pi'] });
  const saved = load(dir);
  expect(saved.default).toEqual(EXISTING);
  expect(saved.favorites).toEqual([
    OPUS, { backend: 'pi', provider: 'acme', model: 'small' }, { backend: 'pi', provider: 'other', model: 'org/model.v1' },
  ]);
});

test('a route already favorited does not gain the newly recommended model', async () => {
  const dir = configDir({ default: EXISTING, favorites: [{ backend: 'pi', provider: 'acme', model: 'custom' }] });
  await seed(dir, { pi: ACME });
  expect(load(dir).favorites).toHaveLength(1);
});

test('a config without a default gets one while its favorites are kept', async () => {
  const dir = configDir({ favorites: [OPUS] });
  const result = await seed(dir, { pi: ACME });
  expect(result.defaultSet).toBe(true);
  expect(load(dir).default.model).toBe('small');
  expect(result.favorites).toHaveLength(2);
});

test('a host whose only Claude connection lists its own models recommends one of those', async () => {
  const dir = configDir();
  await seed(dir, { connections: [claudeView('qwen-ksu', ['qwen-coder'])] });
  expect(load(dir).default).toMatchObject({ backend: 'claude', model: 'qwen-coder' });
});

test('seeding rescans PI, so a provider logged in a moment ago is seen', async () => {
  const dir = configDir();
  const rescan = vi.fn(async () => ACME);
  await seed(dir, { pi: [], rescan });
  expect(rescan).toHaveBeenCalledTimes(1);
  expect(load(dir).default).toMatchObject({ backend: 'pi', provider: 'acme' });
});

test('nothing reachable writes nothing', async () => {
  const dir = configDir();
  const result = await seed(dir, {});
  expect(result).toEqual({ configured: false, routes: 0, defaultSet: false, favorites: [], reason: 'no-routes' });
  expect(fs.existsSync(path.join(dir, 'models.json'))).toBe(false);
});

test('a failing catalog does not fail the login', async () => {
  const catalog = { load: async () => { throw new Error('scan exploded'); }, reload: async () => { throw new Error('scan exploded'); }, peek: () => { throw new Error('unused'); } };
  const result = await seedModelsFromCatalog({ configDir: configDir(), catalog });
  expect(result.configured).toBe(false);
  expect(result.reason).toMatch(/exploded/);
});
