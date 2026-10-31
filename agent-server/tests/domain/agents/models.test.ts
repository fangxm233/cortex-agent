import { beforeEach, expect, test, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importWithFreshRegistry } from '../../helpers/fresh-module.js';

vi.mock('../../../src/agent-adapter/pi/discovery.js', () => ({
  piProviderDiscovery: { peekModels: () => [{ provider: 'catalog-provider', model: 'catalog-model' }] },
}));
const selection = { backend: 'claude', provider: null, model: 'opus', thinking: 'high', connection: 'subscription' };
const pi = { backend: 'pi', provider: 'deepseek', model: 'flash' };
const file = path.join(process.env.CORTEX_HOME!, 'config/models.json');
const state = path.join(process.env.CORTEX_HOME!, 'data/agent-state.json');
const fresh = () => importWithFreshRegistry(() => import('../../../src/domain/agents/models.js'));
beforeEach(() => {
  writeFileSync(file, JSON.stringify({ default: selection, favorites: [pi] }));
  writeFileSync(state, '{}');
});

test('a backend starts from the configured default, then its first favorite, never another backend', async () => {
  const api = await fresh();
  expect(api.backendStartingPoint('claude')).toEqual({ backend: 'claude', provider: null, model: 'opus' });
  expect(api.backendStartingPoint('pi')).toEqual(pi);
  writeFileSync(file, JSON.stringify({ default: selection, favorites: [] }));
  expect((await fresh()).backendStartingPoint('pi')).toBeNull();
});

test('the configured default is null before models.json exists', async () => {
  rmSync(file);
  expect((await fresh()).configuredDefault()).toBeNull();
  writeFileSync(file, JSON.stringify({ default: selection, favorites: [] }));
  expect((await fresh()).configuredDefault()).toEqual(selection);
});

test('refs parse explicit providers, retain model slashes, use favorites and cached catalog synchronously', async () => {
  const api = await fresh();
  expect(api.resolveModelRef('deepseek/vendor/model')).toEqual({ backend: 'pi', provider: 'deepseek', model: 'vendor/model' });
  expect(api.resolveModelRef('sonnet')).toEqual({ backend: 'claude', provider: null, model: 'sonnet' });
  expect(api.resolveModelRef('flash', 'pi')).toEqual(pi);
  expect(api.resolveModelRef('catalog-model', 'pi')).toEqual({ backend: 'pi', provider: 'catalog-provider', model: 'catalog-model' });
  expect(() => api.resolveModelRef('unknown', 'pi')).toThrow(/provider/);
  expect(() => api.resolveModelRef('deepseek/')).toThrow(/model/i);
});

test('default and favorites are defensive snapshots', async () => {
  const api = await fresh();
  api.getDefaultSelection().model = 'mutated';
  api.listFavorites()[0].model = 'mutated';
  expect(api.getDefaultSelection().model).toBe('opus');
  expect(api.listFavorites()[0].model).toBe('flash');
});

test('invalid default and duplicate favorites fail validation', async () => {
  writeFileSync(file, JSON.stringify({ default: { ...selection, thinking: 'off' }, favorites: [] }));
  const invalid = await fresh();
  expect(() => invalid.loadModelsFile()).toThrow(/thinking/);
  writeFileSync(file, JSON.stringify({ default: selection, favorites: [pi, pi] }));
  const duplicate = await fresh();
  expect(() => duplicate.loadModelsFile()).toThrow(/Duplicate/);
});
