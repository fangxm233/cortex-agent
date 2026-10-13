import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  describeModelFields, describeSubagent, type SubagentModelOption,
} from '../../src/core/agents/subagent/catalog.js';
import {
  SUBAGENT_BACKEND_DESCRIPTION, SUBAGENT_MODEL_DESCRIPTION,
} from '../../src/core/agents/subagent/schema.js';

const MODELS: SubagentModelOption[] = [
  { backend: 'pi', provider: 'deepseek', id: 'deepseek-v4-flash' },
  { backend: 'claude', id: 'claude-sonnet-5' },
];

test('the agent tool fields keep the subagent lead-ins', () => {
  const described = describeSubagent({ models: MODELS });
  assert.equal(described.model,
    `${SUBAGENT_MODEL_DESCRIPTION} Known available — claude: claude-sonnet-5; pi: deepseek/deepseek-v4-flash.`);
  assert.equal(described.backend,
    `${SUBAGENT_BACKEND_DESCRIPTION} Both backends have models configured on this host.`);
  assert.deepEqual(describeSubagent({}).model, SUBAGENT_MODEL_DESCRIPTION);
  assert.deepEqual(describeSubagent({}).backend, SUBAGENT_BACKEND_DESCRIPTION);
});

test.each([
  { count: 40, padding: 0 },
  { count: 4, padding: 400 },
])('model descriptions list every model with $count entries and $padding padding', ({ count, padding }) => {
  const models: SubagentModelOption[] = Array.from({ length: count }, (_, index) => ({
    backend: 'pi', provider: 'provider', id: `model-${index}-${'x'.repeat(padding)}`,
  }));
  const descriptions = [
    describeSubagent({ models }).model,
    describeModelFields(models, { model: 'Worker model.', backend: 'Worker backend.' }).model,
  ];
  for (const description of descriptions) {
    for (const model of models) assert.ok(description.includes(`${model.provider}/${model.id}`));
    assert.doesNotMatch(description, /\(\+\d+ more\)/);
  }
});

test('model descriptions retain normalization, deduplication and ordering', () => {
  const models: SubagentModelOption[] = [
    { backend: 'pi', provider: ' p ', id: ' z ' },
    { backend: 'claude', id: ' b ' },
    { backend: 'pi', provider: 'p', id: 'z' },
    { backend: 'claude', id: 'a' },
    { backend: 'pi', id: ' ' },
  ];
  assert.equal(describeSubagent({ models }).model,
    `${SUBAGENT_MODEL_DESCRIPTION} Known available — claude: a, b; pi: p/z.`);
});

test('another tool lists the same catalog behind its own lead-ins', () => {
  const bases = { model: 'Worker model.', backend: 'Worker backend.' };
  assert.deepEqual(describeModelFields(MODELS, bases), {
    model: 'Worker model. Known available — claude: claude-sonnet-5; pi: deepseek/deepseek-v4-flash.',
    backend: 'Worker backend. Both backends have models configured on this host.',
  });
  assert.deepEqual(describeModelFields([], bases), bases, 'an empty catalog renders the lead-ins alone');
  assert.deepEqual(describeModelFields([{ backend: 'pi', provider: 'p', id: 'm' }], bases).backend,
    'Worker backend. Only "pi" has models configured on this host.');
});
