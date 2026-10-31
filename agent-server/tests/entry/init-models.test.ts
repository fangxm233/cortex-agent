import { expect, test, vi } from 'vitest';

vi.mock('@core/log.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { choiceSelection, parseChoiceValue } from '../../src/entry/init-models.js';
import type { CatalogSnapshot } from '../../src/domain/models/catalog.js';

const SNAPSHOT: CatalogSnapshot = {
  routes: [
    {
      backend: 'claude', provider: null, connections: ['subscription', 'relay'], models: ['opus', 'shared'],
      source: 'builtin', modelThinking: {}, modelConnections: {},
    },
    { backend: 'pi', provider: 'deepseek', connections: [], models: ['flash', 'shared'], source: 'pi', modelThinking: {}, modelConnections: {} },
    { backend: 'pi', provider: 'anthropic', connections: [], models: ['opus'], source: 'pi', modelThinking: {}, modelConnections: {} },
  ],
  piPending: false,
  thinkingLevels: { claude: [], pi: [] },
};

test.each([
  ['claude', 'opus', { backend: 'claude', provider: null, connection: null }],
  ['plan', 'opus', { backend: 'claude', provider: null, connection: null }],
  ['api', 'shared', { backend: 'claude', provider: null, connection: null }],
  ['relay', 'opus', { backend: 'claude', provider: null, connection: 'relay' }],
  ['deepseek', 'shared', { backend: 'pi', provider: 'deepseek', connection: null }],
  ['pi-anthropic', 'opus', { backend: 'pi', provider: 'anthropic', connection: null }],
])('route %s with model %s resolves through the catalog', (route, model, expected) => {
  expect(choiceSelection(SNAPSHOT, { route, model })).toEqual({ ...expected, model, thinking: null });
});

test('a choice the host cannot run is refused', () => {
  expect(() => choiceSelection(SNAPSHOT, { route: 'deepseek', model: 'opus' })).toThrow(/not among the models/);
  expect(() => choiceSelection(SNAPSHOT, { route: 'gone', model: 'opus' })).toThrow(/not among the models/);
});

test('answers name a model by backend and provider; older answers by mode', () => {
  expect(parseChoiceValue({ backend: 'pi', provider: 'deepseek', model: 'flash' })).toEqual({ route: 'deepseek', model: 'flash' });
  expect(parseChoiceValue({ backend: 'claude', model: 'opus' })).toEqual({ route: 'claude', model: 'opus' });
  expect(parseChoiceValue({ mode: 'plan', model: 'opus' })).toEqual({ route: 'plan', model: 'opus' });
  expect(parseChoiceValue({ backend: 'pi', model: 'flash' })).toBeUndefined();
});
