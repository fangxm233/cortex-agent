import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  claudeModelOptions, describeModelCatalog, describeSubagent, type SubagentModelOption,
} from '../../src/core/agents/subagent/catalog.js';
import {
  SUBAGENT_BACKEND_DESCRIPTION, SUBAGENT_MODEL_DESCRIPTION,
} from '../../src/core/agents/subagent/schema.js';

const MODELS: SubagentModelOption[] = [
  { backend: 'pi', provider: 'deepseek', id: 'deepseek-v4-flash' },
  { backend: 'claude', id: 'claude-sonnet-5' },
];

test('model fields stay short while the top-level directory names both backends', () => {
  const described = describeSubagent({ models: MODELS });
  assert.equal(described.model, SUBAGENT_MODEL_DESCRIPTION);
  assert.equal(described.backend, SUBAGENT_BACKEND_DESCRIPTION);
  assert.equal(described.catalog, ' Known models — claude: claude-sonnet-5; pi: deepseek/deepseek-v4-flash.');
  assert.equal(describeSubagent({}).catalog, '');
  assert.equal(describeSubagent({}).model, SUBAGENT_MODEL_DESCRIPTION);
  assert.equal(describeSubagent({}).backend, SUBAGENT_BACKEND_DESCRIPTION);
});

test.each([
  { count: 40, padding: 0 },
  { count: 4, padding: 400 },
])('catalog lists every model with $count entries and $padding padding', ({ count, padding }) => {
  const models: SubagentModelOption[] = Array.from({ length: count }, (_, index) => ({
    backend: 'pi', provider: 'provider', id: `model-${index}-${'x'.repeat(padding)}`,
  }));
  const description = describeModelCatalog(models);
  for (const model of models) assert.ok(description.includes(`${model.provider}/${model.id}`));
  assert.doesNotMatch(description, /\(\+\d+ more\)/);
});

test('model catalog retains normalization, deduplication and ordering', () => {
  const models: SubagentModelOption[] = [
    { backend: 'pi', provider: ' p ', id: ' z ' },
    { backend: 'claude', id: ' b ' },
    { backend: 'pi', provider: 'p', id: 'z' },
    { backend: 'claude', id: 'a' },
    { backend: 'pi', id: ' ' },
  ];
  assert.equal(describeSubagent({ models }).catalog, ' Known models — claude: a, b; pi: p/z.');
});

test('single-backend and empty catalogs remain valid', () => {
  assert.equal(describeModelCatalog([{ backend: 'pi', provider: 'p', id: 'm' }]), ' Known models — pi: p/m.');
  assert.equal(describeModelCatalog([]), '');
});


test('an empty discovered Claude cache falls back to shipped choices and includes the parent', () => {
  const models = claudeModelOptions('unlisted-parent', []);
  assert.ok(models.length > 1);
  assert.equal(models.filter(model => model.id === 'unlisted-parent').length, 1);
  assert.equal(describeModelCatalog(models).split('unlisted-parent').length - 1, 1);
});
