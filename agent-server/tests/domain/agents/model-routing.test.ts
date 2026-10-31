import { expect, test } from 'vitest';
import { validateEngineSelection } from '../../../src/domain/agents/engine-selection.js';
import type { ClaudeRoute } from '../../../src/domain/connections/claude-route.js';
import { specFromFixture } from '../../run-request-fixture.js';

const selection = { model: 'm', backend: 'pi', connection: null, provider: 'anthropic', thinking: null };

test('PI requires an explicit safe provider, Claude requires null', () => {
  expect(() => validateEngineSelection(selection)).not.toThrow();
  expect(() => validateEngineSelection({ ...selection, provider: undefined })).toThrow(/provider/);
  expect(() => validateEngineSelection({ ...selection, provider: null })).toThrow(/provider/);
  expect(() => validateEngineSelection({ ...selection, provider: 'has spaces' })).toThrow(/provider/);
  expect(() => validateEngineSelection({ ...selection, backend: 'claude', provider: null })).not.toThrow();
  expect(() => validateEngineSelection({ ...selection, backend: 'claude' })).toThrow(/provider/);
});

test('a Claude relay route sets its base URL and credential and unsets the rest', () => {
  const route: ClaudeRoute = {
    connection: 'relay', baseUrl: 'https://relay.example.test',
    sets: { ANTHROPIC_AUTH_TOKEN: 'fake-relay-token' }, unsets: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  };
  const spec = specFromFixture({ loadCortexRules: false }, { backend: 'claude', connection: 'relay' }, route);
  expect(spec.route).toEqual({ anthropicBaseUrl: 'https://relay.example.test', connection: 'relay' });
  expect(spec.env.sets).toEqual({ ANTHROPIC_AUTH_TOKEN: 'fake-relay-token' });
  expect(spec.env.unsets).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
});

test('a route without a base URL deletes ANTHROPIC_BASE_URL so the child cannot inherit one', () => {
  const route: ClaudeRoute = {
    connection: 'subscription', sets: {},
    unsets: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
  };
  const spec = specFromFixture({ loadCortexRules: false }, { backend: 'claude' }, route);
  expect(spec.route.anthropicBaseUrl).toBeUndefined();
  expect(spec.env.sets).toBeUndefined();
  expect(spec.env.unsets).toContain('ANTHROPIC_BASE_URL');
});

test('PI carries no Claude route: its provider is the connection', () => {
  const spec = specFromFixture(
    { loadCortexRules: false },
    { model: 'gpt-x', backend: 'pi', connection: null, provider: 'openai-codex' },
  );
  expect(spec.model.provider).toBe('openai-codex');
  expect(spec.route).toEqual({ anthropicBaseUrl: undefined, connection: undefined });
  expect(spec.env.sets).toBeUndefined();
  // Nothing a PI run inherits may carry Claude's routing.
  expect(spec.env.unsets).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
});
