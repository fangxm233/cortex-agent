import { expect, test } from 'vitest';
import { isValidThinkingLevel, modelKey, validateEngineSelection } from '../../../src/domain/agents/engine-selection.js';
import { validateModelsFile } from '../../../src/domain/agents/models.js';
import { specFromFixture } from '../../run-request-fixture.js';

const claude = { backend: 'claude', provider: null, model: 'opus', thinking: null, mode: 'plan' };
const pi = { ...claude, backend: 'pi', provider: 'deepseek', mode: 'deepseek' };
for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
  test(`Claude accepts thinking=${level}`, () => {
    expect(isValidThinkingLevel('claude', level)).toBe(true);
    expect(() => validateEngineSelection({ ...claude, thinking: level })).not.toThrow();
  });
}
for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
  test(`PI accepts thinking=${level}`, () => {
    expect(isValidThinkingLevel('pi', level)).toBe(true);
    expect(() => validateEngineSelection({ ...pi, thinking: level })).not.toThrow();
  });
}

test('thinking validation is backend-specific; null explicitly means CLI default', () => {
  expect(() => validateEngineSelection({ ...claude, thinking: 'off' })).toThrow(/thinking/);
  expect(() => validateEngineSelection({ ...pi, thinking: 'max' })).toThrow(/thinking/);
  expect(() => validateEngineSelection({ ...claude, thinking: undefined })).toThrow(/thinking/);
  expect(() => validateEngineSelection(claude)).not.toThrow();
  expect(() => validateEngineSelection(pi)).not.toThrow();
});

test('removed backend, missing selection fields and unsafe routes are rejected', () => {
  expect(() => validateEngineSelection({ ...claude, backend: 'codex' })).toThrow(/backend/);
  expect(() => validateEngineSelection({ model: 'opus' })).toThrow();
  expect(() => validateEngineSelection({ ...claude, mode: '../api' })).toThrow(/mode/);
});

test('model keys separate backend and provider, without delimiter collisions', () => {
  expect(modelKey({ backend: 'claude', provider: null, model: 'opus' })).toBe('["claude",null,"opus"]');
  const a = modelKey({ backend: 'pi', provider: 'a', model: 'b/c' });
  const b = modelKey({ backend: 'pi', provider: 'a/b', model: 'c' });
  expect(a).not.toBe(b);
});

test('models file requires a full default and a list of unique model-level favorites', () => {
  expect(() => validateModelsFile({ default: claude, favorites: [] })).not.toThrow();
  expect(() => validateModelsFile({ favorites: [] })).toThrow();
  expect(() => validateModelsFile({ default: claude, favorites: {} })).toThrow(/favorites/);
  expect(() => validateModelsFile({ default: claude, favorites: [{ model: 'bad' }] })).toThrow();
});

test('thinking reaches the backend engine spec', () => {
  const spec = specFromFixture({ sessionKey: 'k' }, { model: 'opus', backend: 'claude', thinking: 'high' });
  expect(spec.model.thinking).toBe('high');
});

test('PI provider identity and its route reach the backend engine spec', () => {
  const spec = specFromFixture({ sessionKey: 'k' }, {
    model: 'gpt-5.4-mini', backend: 'pi', provider: 'openai-codex', mode: 'openai-codex',
  });
  expect(spec.model.provider).toBe('openai-codex');
  expect(spec.route.gatewayPath).toBe('/m/openai-codex/openai-codex');
});
