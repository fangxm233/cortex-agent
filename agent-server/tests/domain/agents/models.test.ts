import { beforeEach, expect, test, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { importWithFreshRegistry } from '../../helpers/fresh-module.js';

vi.mock('../../../src/core/gateway-generator.js', () => ({
  readGatewayYaml: () => ({ endpoints: { anthropic: { api: {}, plan: {} } } }),
}));
vi.mock('../../../src/agent-adapter/pi/discovery.js', () => ({
  piProviderDiscovery: { peekModels: () => [{ provider: 'catalog-provider', model: 'catalog-model' }] },
}));
const selection = { backend: 'claude', provider: null, model: 'opus', thinking: 'high', mode: 'plan' };
const pi = { backend: 'pi', provider: 'deepseek', model: 'flash' };
const file = path.join(process.env.CORTEX_HOME!, 'config/models.json');
const state = path.join(process.env.CORTEX_HOME!, 'data/agent-state.json');
const fresh = () => importWithFreshRegistry(() => import('../../../src/domain/agents/models.js'));
beforeEach(() => {
  writeFileSync(file, JSON.stringify({ default: selection, favorites: [pi] }));
  writeFileSync(state, '{}');
});

test('backend default uses configured default, then first favorite, never another backend', async () => {
  const api = await fresh();
  expect(api.getDefaultSelectionForBackend('claude')).toEqual(selection);
  expect(api.getDefaultSelectionForBackend('pi')).toEqual({ ...pi, thinking: null, mode: 'deepseek' });
  writeFileSync(file, JSON.stringify({ default: selection, favorites: [] }));
  expect((await fresh()).getDefaultSelectionForBackend('pi')).toBeNull();
});

test('model selection restores memory and otherwise uses null thinking and first route', async () => {
  writeFileSync(state, JSON.stringify({ modelMemory: {
    '["pi","deepseek","flash"]': { thinking: 'xhigh', mode: 'metered' },
  } }));
  const api = await fresh();
  expect(api.selectionForModel(pi as never)).toEqual({ ...pi, thinking: 'xhigh', mode: 'metered' });
  expect(api.selectionForModel({ backend: 'claude', provider: null, model: 'sonnet' }))
    .toEqual({ backend: 'claude', provider: null, model: 'sonnet', thinking: null, mode: 'api' });
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
