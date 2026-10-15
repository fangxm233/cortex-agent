import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addFavorite, removeFavorite, setDefaultModel } from '../../../src/domain/ui-service/mutate/models.js';
import { modelsFavoriteInput, modelsSetDefaultInput } from '../../../src/domain/ui-service/input-schemas.js';
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';

const invalidate = vi.hoisted(() => vi.fn());
vi.mock('../../../src/store/models-repo.js', () => ({ modelsRepo: { invalidate } }));
const selection: EngineSelection = { backend: 'claude', provider: null, model: 'opus', thinking: 'high', mode: 'plan' };
const ref = { backend: 'claude' as const, provider: null, model: 'opus' };
const pi = { backend: 'pi' as const, provider: 'openai', model: 'gpt' };
const noGateway = () => null;
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
  const next = { ...pi, thinking: null, mode: 'openai' };
  assert.equal(await setDefaultModel(dir, { selection: next }, noGateway), true);
  assert.deepEqual(await read(dir), { default: next, favorites: [ref], future: true });
  assert.equal(await setDefaultModel(dir, { selection: next }, noGateway), false);
});

test('setDefault treats equivalent field order as a no-op', async () => {
  const dir = await seed({ default: { mode: 'plan', thinking: 'high', model: 'opus', provider: null, backend: 'claude' } });
  invalidate.mockClear();
  assert.equal(await setDefaultModel(dir, { selection }, noGateway), false);
  assert.equal(invalidate.mock.calls.length, 0);
});

test('setDefault initializes a missing file without inventing favorites', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-init-'));
  assert.equal(await setDefaultModel(dir, { selection }, noGateway), true);
  assert.deepEqual(await read(dir), { default: selection, favorites: [] });
});

test('setDefault rejects invalid thinking or provider and preserves the old selection', async () => {
  const dir = await seed();
  for (const next of [{ ...pi, thinking: 'max', mode: 'openai' }, { ...selection, provider: 'openai' }]) {
    await assert.rejects(() => setDefaultModel(dir, { selection: next }, noGateway), (e: any) => e.code === 'invalid-args');
  }
  assert.deepEqual((await read(dir)).default, selection);
});

test('setDefault checks declared gateway routes before writing', async () => {
  const dir = await seed();
  const gateway = () => ({ endpoints: { anthropic: { plan: {} } } }) as any;
  await assert.rejects(() => setDefaultModel(dir, { selection: { ...selection, mode: 'missing' } }, gateway),
    (e: any) => e.code === 'invalid-args');
  assert.deepEqual((await read(dir)).default, selection);
});

test('setDefault rejects an endpoint absent from a readable gateway', async () => {
  const dir = await seed();
  const gateway = () => ({ top: {}, endpoints: {} });
  await assert.rejects(() => setDefaultModel(dir, { selection }, gateway), (e: any) => e.code === 'invalid-args');
  assert.deepEqual((await read(dir)).default, selection);
});

test('strict models schemas accept concrete nullable fields but reject retired options', () => {
  assert.equal(modelsSetDefaultInput.safeParse({ selection }).success, true);
  assert.equal(modelsSetDefaultInput.safeParse({ selection: { ...selection, thinking: null } }).success, true);
  assert.equal(modelsFavoriteInput.safeParse({ backend: 'claude', model: 'opus' }).success, true);
  assert.equal(modelsFavoriteInput.safeParse({ ...ref, thinking: 'high' }).success, false);
  assert.equal(modelsSetDefaultInput.safeParse({ selection: { ...selection, extraOption: {} } }).success, false);
  assert.equal(modelsSetDefaultInput.safeParse({ selection: { model: 'opus' } }).success, false);
});

test('setDefault completes an unconfigured file and remembers its model settings', async () => {
  const dir = await seed({ default: null });
  assert.equal(await setDefaultModel(dir, { selection }, noGateway), true);
  assert.deepEqual((await read(dir)).default, selection);
  const { getModelMemory } = await import('../../../src/domain/agents/config.js');
  assert.deepEqual(getModelMemory()['["claude",null,"opus"]'], { thinking: 'high', mode: 'plan' });
});
