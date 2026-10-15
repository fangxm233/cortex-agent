import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateModels, mergeModelsJson, listChoices, recommendedChoice, writeModelsJson } from '../../src/core/models-generator.js';
import type { DiscoveredEndpoint } from '../../src/core/gateway-generator.js';

function ep(mode: string, endpoint: string, models: string[], defaultModel?: string): DiscoveredEndpoint {
  return { mode, endpoint, models, defaultModel, base_url: 'https://example.test', auth_style: 'bearer', keys: [], passthrough: true, gatewayManaged: true };
}
const claude = ep('plan', 'anthropic', ['opus', 'sonnet']);
const pi = ep('deepseek', 'deepseek', ['flash', 'pro'], 'pro');
function withDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-models-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('generation requires a discovered default rather than inventing an unconfigured engine', () => {
  assert.throws(() => generateModels([]), /no.*model/i);
});
test('recommended choice follows discovery order and endpoint default, not alphabetical order', () => {
  assert.deepEqual(recommendedChoice([pi, claude]), { mode: 'deepseek', model: 'pro' });
  assert.deepEqual(recommendedChoice([claude, pi]), { mode: 'plan', model: 'opus' });
  assert.equal(recommendedChoice([ep('empty', 'empty', [])]), undefined);
  assert.deepEqual(recommendedChoice([ep('pi', 'pi', ['first'], 'stale')]), { mode: 'pi', model: 'first' });
});
test('generated default is complete and always favorited, without inventing other favorites', () => {
  assert.deepEqual(generateModels([claude, pi]), {
    default: { backend: 'claude', provider: null, model: 'opus', thinking: null, mode: 'plan' },
    favorites: [{ backend: 'claude', provider: null, model: 'opus' }],
  });
});
test('explicit choices carry PI provider and deduplicate favorites across routes', () => {
  const result = generateModels([claude, ep('api', 'anthropic', ['opus']), pi], {
    defaultChoice: { mode: 'deepseek', model: 'flash' },
    favorites: [{ mode: 'plan', model: 'opus' }, { mode: 'api', model: 'opus' }, { mode: 'deepseek', model: 'flash' }],
  });
  assert.deepEqual(result.default, { backend: 'pi', provider: 'deepseek', model: 'flash', thinking: null, mode: 'deepseek' });
  assert.equal(result.favorites.length, 2);
  assert.deepEqual(Object.keys(result), ['default', 'favorites']);
});
test('model IDs are preserved verbatim and not used as names', () => {
  const result = generateModels([ep('openai', 'openai', ['gpt-5.4-mini', 'plan'])], { favorites: [{ mode: 'openai', model: 'plan' }] });
  assert.deepEqual(result.favorites.map(m => m.model), ['gpt-5.4-mini', 'plan']);
});
test('unknown default and favorite choices are rejected', () => {
  const invalid = { mode: 'missing', model: 'missing' };
  assert.throws(() => generateModels([claude], { defaultChoice: invalid }), /not found/);
  assert.throws(() => generateModels([claude], { favorites: [invalid] }), /not found/);
});
test('display choices are sorted by mode then model', () => {
  assert.deepEqual(listChoices([claude, pi]), [
    { mode: 'deepseek', model: 'flash' }, { mode: 'deepseek', model: 'pro' },
    { mode: 'plan', model: 'opus' }, { mode: 'plan', model: 'sonnet' },
  ]);
});
test('merge preserves customized default and unions favorites; overwrite changes only default', () => withDir(dir => {
  const existing = generateModels([claude]);
  existing.default.thinking = 'high';
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify(existing));
  const generated = generateModels([pi]);
  const preserved = mergeModelsJson(generated, dir);
  assert.deepEqual(preserved.default, existing.default);
  assert.deepEqual(preserved.favorites, [...existing.favorites, ...generated.favorites]);
  assert.deepEqual(mergeModelsJson(generated, dir, true), { ...preserved, default: generated.default });
}));
test('missing, malformed and default-less files can be initialized', () => withDir(dir => {
  const generated = generateModels([claude]);
  assert.deepEqual(mergeModelsJson(generated, dir), generated);
  fs.writeFileSync(path.join(dir, 'models.json'), '{bad');
  assert.deepEqual(mergeModelsJson(generated, dir), generated);
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ favorites: [] }));
  assert.deepEqual(mergeModelsJson(generated, dir), generated);
}));
test('write uses models.json and honors overwrite', () => withDir(dir => {
  const file = writeModelsJson([claude], { outputDir: dir });
  assert.equal(file, path.join(dir, 'models.json'));
  writeModelsJson([pi], { outputDir: dir, overwrite: true });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).default.model, 'pro');
}));
test('default write location uses isolated CORTEX_HOME', () => {
  const file = writeModelsJson([claude]);
  assert.equal(file, path.join(process.env.CORTEX_HOME!, 'config', 'models.json'));
});
