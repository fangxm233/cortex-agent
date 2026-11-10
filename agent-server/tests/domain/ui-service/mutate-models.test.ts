import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addFavorite, removeFavorite, setDefaultModel, setDelegation, setModelThinking, handleModelsSetThinking } from '../../../src/domain/ui-service/mutate/models.js';
import { modelsFavoriteInput, modelsSetDefaultInput, modelsSetThinkingInput } from '../../../src/domain/ui-service/input-schemas.js';
import { getModelMemory, getChannelSelection, getSelectionDefault, reloadAgentState, rememberModelSelection, setChannelSelection, setSelectionDefault } from '../../../src/domain/agents/config.js';
import { loadAgentState } from '../../../src/domain/agents/agent-state.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import { modelKey } from '../../../src/domain/agents/engine-selection.js';
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';
import { upsertConnection } from '../../../src/core/connections-file.js';
import { createCredentialInventory } from '../../../src/domain/connections/inventory.js';

const invalidate = vi.hoisted(() => vi.fn());
vi.mock('../../../src/store/models-repo.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/store/models-repo.js')>(),
  modelsRepo: { invalidate },
}));
const selection: EngineSelection = { backend: 'claude', provider: null, model: 'opus', thinking: 'high', connection: 'api' };
const ref = { backend: 'claude' as const, provider: null, model: 'opus' };
const pi = { backend: 'pi' as const, provider: 'openai', model: 'gpt' };
/** A host whose Claude connections are stored API keys with these ids, and no Claude login. */
function inventoryWith(ids: string[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'models-connections-'));
  const file = path.join(dir, 'connections.json');
  for (const id of ids) {
    upsertConnection({ id, backend: 'claude', label: id, authStyle: 'x-api-key', key: `sk-test-${id}-fake`, billing: 'metered' }, file);
  }
  return createCredentialInventory({ file, claude: { claudeConfigDir: path.join(dir, 'no-claude') } });
}
const inventory = inventoryWith(['api']);
async function seed(extra = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-write-'));
  await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({ default: selection, favorites: [ref], ...extra }));
  return dir;
}
async function read(dir: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(dir, 'models.json'), 'utf8'));
}

test('adding a favorite preserves default and unknown file fields and leaves no temporary files', async () => {
  const dir = await seed({ future: { keep: true } });
  assert.equal(await addFavorite(dir, pi), true);
  assert.deepEqual(await read(dir), { default: selection, favorites: [ref, pi], future: { keep: true } });
  assert.deepEqual(await fs.readdir(dir), ['models.json']);
});

test('favorite identity includes backend/provider/model; duplicates are no-op writes', async () => {
  const dir = await seed();
  invalidate.mockClear();
  assert.equal(await addFavorite(dir, { backend: 'claude', model: 'opus' }), false);
  assert.equal(invalidate.mock.calls.length, 0);
  assert.equal(await addFavorite(dir, { ...pi, model: 'opus' }), true);
  assert.equal(invalidate.mock.calls.length, 1);
  assert.equal((await read(dir)).favorites.length, 2);
});

test('concurrent read-modify-write operations do not lose favorites', async () => {
  const dir = await seed();
  await Promise.all([addFavorite(dir, pi), addFavorite(dir, { backend: 'claude', model: 'sonnet' })]);
  assert.equal((await read(dir)).favorites.length, 3);
});

test('removing even the default or last favorite leaves the independent default intact', async () => {
  const dir = await seed();
  assert.equal(await removeFavorite(dir, ref), true);
  assert.deepEqual(await read(dir), { default: selection, favorites: [] });
  assert.equal(await removeFavorite(dir, ref), false);
});

test('favorite mutations reject invalid providers and unknown backend without writing', async () => {
  const dir = await seed();
  for (const input of [{ backend: 'pi', model: 'gpt' }, { ...ref, provider: 'openai' }, { ...ref, backend: 'other' }]) {
    await assert.rejects(() => addFavorite(dir, input as any), (e: any) => e.code === 'invalid-args');
  }
  assert.deepEqual((await read(dir)).favorites, [ref]);
});

test('missing or malformed models file is rejected by favorites rather than overwritten', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-empty-'));
  await assert.rejects(() => addFavorite(dir, ref), (e: any) => e.code === 'invalid-args');
  await fs.writeFile(path.join(dir, 'models.json'), '{bad');
  await assert.rejects(() => removeFavorite(dir, ref), (e: any) => e.code === 'invalid-args');
});

test('setDefault replaces the whole choice, preserves favorites and reports no-op', async () => {
  const dir = await seed({ future: true });
  const next = { ...pi, thinking: null, connection: null };
  assert.equal(await setDefaultModel(dir, { selection: next }, { inventory }), true);
  assert.deepEqual(await read(dir), { default: next, favorites: [ref], future: true });
  assert.equal(await setDefaultModel(dir, { selection: next }, { inventory }), false);
});

test('setDefault treats equivalent field order as a no-op', async () => {
  const dir = await seed({ default: { connection: 'api', thinking: 'high', model: 'opus', provider: null, backend: 'claude' } });
  invalidate.mockClear();
  assert.equal(await setDefaultModel(dir, { selection }, { inventory }), false);
  assert.equal(invalidate.mock.calls.length, 0);
});

test('setDefault initializes a missing file without inventing favorites', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-init-'));
  assert.equal(await setDefaultModel(dir, { selection }, { inventory }), true);
  assert.deepEqual(await read(dir), { default: selection, favorites: [] });
});

test('setDefault rejects invalid thinking or provider and preserves the old selection', async () => {
  const dir = await seed();
  for (const next of [{ ...pi, thinking: 'ultra', connection: null }, { ...selection, provider: 'openai' }, { ...pi, thinking: null, connection: 'api' }]) {
    await assert.rejects(() => setDefaultModel(dir, { selection: next }, { inventory }), (e: any) => e.code === 'invalid-args');
  }
  assert.deepEqual((await read(dir)).default, selection);
});

test('setDefault checks that a newly named connection exists before writing', async () => {
  const dir = await seed();
  await assert.rejects(() => setDefaultModel(dir, { selection: { ...selection, connection: 'missing' } }, { inventory: inventoryWith(['api', 'other']) }),
    (e: any) => e.code === 'invalid-args' && /invalid-connection/.test(e.message) && /api, other/.test(e.message));
  assert.deepEqual((await read(dir)).default, selection);
});

test('setDefault keeping a connection that has since been removed drops it instead of failing', async () => {
  const dir = await seed();
  assert.equal(await setDefaultModel(dir, { selection: { ...selection, thinking: 'low' } }, { inventory: inventoryWith([]) }), true);
  assert.deepEqual((await read(dir)).default, { ...selection, thinking: 'low', connection: null });
});

test('setDefault naming no connection runs on the default and needs none to exist', async () => {
  const dir = await seed();
  const next = { ...selection, connection: null };
  assert.equal(await setDefaultModel(dir, { selection: next }, { inventory: inventoryWith([]) }), true);
  assert.deepEqual((await read(dir)).default, next);
});

test('strict models schemas accept concrete nullable fields but reject retired options', () => {
  assert.equal(modelsSetDefaultInput.safeParse({ selection }).success, true);
  assert.equal(modelsSetDefaultInput.safeParse({ selection: { ...selection, thinking: null } }).success, true);
  assert.equal(modelsFavoriteInput.safeParse({ backend: 'claude', model: 'opus' }).success, true);
  assert.equal(modelsFavoriteInput.safeParse({ ...ref, thinking: 'high' }).success, false);
  assert.equal(modelsSetDefaultInput.safeParse({ selection: { ...selection, extraOption: {} } }).success, false);
  assert.equal(modelsSetDefaultInput.safeParse({ selection: { model: 'opus' } }).success, false);
  assert.equal(modelsSetDefaultInput.safeParse({ selection: { ...selection, connection: null } }).success, true);
  assert.equal(modelsSetDefaultInput.safeParse({ selection: { ...selection, mode: 'plan' } }).success, false);
});

test('setDefault completes an unconfigured file and remembers its model settings', async () => {
  const dir = await seed({ default: null });
  assert.equal(await setDefaultModel(dir, { selection }, { inventory }), true);
  assert.deepEqual((await read(dir)).default, selection);
  const { getModelMemory } = await import('../../../src/domain/agents/config.js');
  assert.deepEqual(getModelMemory()['["claude",null,"opus"]'], { thinking: 'high' });
});

test('setThinking persists only the favorite memory and preserves independent choices', async () => {
  const dir = await seed({ favorites: [ref, pi] });
  rememberModelSelection({ ...selection, connection: 'subscription' });
  rememberModelSelection({ ...pi, thinking: 'off', connection: null });
  setChannelSelection('test-channel', selection);
  setSelectionDefault({ ...selection, agentName: 'main' });
  const before = loadAgentState();
  const file = await fs.readFile(path.join(dir, 'models.json'), 'utf8');
  assert.equal(await setModelThinking(dir, { ref, thinking: 'max' }), true);
  reloadAgentState();
  assert.deepEqual(getModelMemory()[modelKey(ref)], { thinking: 'max' });
  assert.deepEqual(loadAgentState(), { ...before, modelMemory: {
    ...before.modelMemory, [modelKey(ref)]: { thinking: 'max' },
  } });
  assert.deepEqual(getChannelSelection('test-channel'), selection);
  assert.deepEqual(getSelectionDefault(), { ...selection, agentName: 'main' });
  assert.equal(await fs.readFile(path.join(dir, 'models.json'), 'utf8'), file);
});

test('setThinking distinguishes null from off and reports no-op without persisting again', async () => {
  const dir = await seed({ favorites: [pi] });
  rememberModelSelection({ ...pi, thinking: 'off', connection: null });
  assert.equal(await setModelThinking(dir, { ref: pi, thinking: null }), true);
  const { STORE_DIR } = await import('../../../src/core/paths.js');
  const stat = await fs.stat(path.join(STORE_DIR, 'agent-state.json'));
  assert.equal(await setModelThinking(dir, { ref: pi, thinking: null }), false);
  assert.equal((await fs.stat(path.join(STORE_DIR, 'agent-state.json'))).mtimeMs, stat.mtimeMs);
  reloadAgentState();
  assert.deepEqual(getModelMemory()[modelKey(pi)], { thinking: null });
});

test('setThinking initializes first-time memory', async () => {
  const first = { ...pi, model: 'first-time' };
  const dir = await seed({ favorites: [first] });
  assert.equal(await setModelThinking(dir, { ref: first, thinking: null }), true);
  assert.deepEqual(getModelMemory()[modelKey(first)], { thinking: null });
  rememberModelSelection({ ...first, thinking: 'high', connection: null });
  assert.deepEqual(getModelMemory()[modelKey(first)], { thinking: 'high' });
});

test('setThinking rejects invalid identity, unfavorited models and backend-invalid levels without writes', async () => {
  const dir = await seed({ favorites: [ref, pi] });
  const before = loadAgentState();
  const inputs = [
    { ref: { ...ref, provider: 'openai' }, thinking: 'high' },
    { ref: { ...pi, provider: null }, thinking: 'high' },
    { ref: { ...ref, model: 'not-favorited' }, thinking: 'high' },
    { ref: pi, thinking: 'ultra' }, { ref, thinking: 'off' }, { ref, thinking: '__default__' },
  ];
  for (const input of inputs) {
    await assert.rejects(() => setModelThinking(dir, input), (error: any) => error.code === 'invalid-args');
  }
  assert.deepEqual(loadAgentState(), before);
});

test('setThinking schema accepts only a model ref and explicit nullable thinking', () => {
  assert.equal(modelsSetThinkingInput.safeParse({ ref, thinking: null }).success, true);
  for (const input of [{ ref }, { ref, thinking: 1 }, { ref, thinking: null, mode: 'plan' }, { ref, thinking: null, connection: 'api' },
    { ref: { ...ref, mode: 'plan' }, thinking: 'high' }]) {
    assert.equal(modelsSetThinkingInput.safeParse(input).success, false);
  }
});

test('setThinking handler never invokes current-session mutation dependencies', async () => {
  const { CONFIG_DIR } = await import('../../../src/core/paths.js');
  await fs.writeFile(path.join(CONFIG_DIR, 'models.json'), JSON.stringify({ default: selection, favorites: [ref] }));
  const deps = new Proxy({} as UiServiceDeps, {
    get(_target, key) { assert.fail(`Model memory edit accessed session/service dependency ${String(key)}`); },
  });
  assert.deepEqual(await handleModelsSetThinking(deps, { ref, thinking: 'medium' }), { ok: true, data: { changed: true } });
  const invalid = await handleModelsSetThinking(deps, { ref, thinking: 'off' });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.code, 'invalid-args');
});

test('the delegation policy is written whole, deduplicated, and a repeat is a no-op', async () => {
  const dir = await seed({ future: { keep: true } });
  assert.equal(await setDelegation(dir, { allow: 'favorites', deny: ['openai/*-pro', 'openai/*-pro'] }), true);
  assert.deepEqual((await read(dir)).delegation, { allow: 'favorites', deny: ['openai/*-pro'] });
  assert.deepEqual((await read(dir)).future, { keep: true });
  assert.equal(await setDelegation(dir, { allow: 'favorites', deny: ['openai/*-pro'] }), false);
  assert.equal(await setDelegation(dir, { allow: [' claude-* ', 'deepseek/*'], deny: [] }), true);
  assert.deepEqual((await read(dir)).delegation, { allow: ['claude-*', 'deepseek/*'], deny: [] });
  await assert.rejects(setDelegation(dir, { allow: 'some' as never, deny: [] }), { code: 'invalid-args' });
  await assert.rejects(setDelegation(dir, { allow: 'all', deny: [''] }), { code: 'invalid-args' });
});

test('saving the default policy on a file without one records it explicitly', async () => {
  const dir = await seed();
  assert.equal(await setDelegation(dir, { allow: 'favorites', deny: [] }), true);
  assert.deepEqual((await read(dir)).delegation, { allow: 'favorites', deny: [] });
});
