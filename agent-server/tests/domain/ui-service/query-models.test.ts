import assert from 'node:assert/strict';
import { test } from 'vitest';

import { handleModelsCatalog } from '../../../src/domain/ui-service/query/models.js';
import type { ModelCatalog } from '../../../src/domain/models/catalog.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const DEPS = {} as UiServiceDeps;

test('the picker DTO mirrors the catalog, naming each route\'s endpoint for older clients', async () => {
  const catalog: ModelCatalog = {
    peek: () => { throw new Error('the picker waits for the list; it never peeks'); },
    reload: () => { throw new Error('the picker never rescans'); },
    load: async () => ({
      routes: [
        {
          backend: 'claude', provider: null, connections: ['subscription', 'qwen-ksu'], models: ['opus', 'qwen'],
          source: 'builtin', modelThinking: { opus: ['low'] }, modelConnections: { qwen: ['qwen-ksu'], opus: ['subscription'] },
        },
        {
          backend: 'pi', provider: 'deepseek', connections: [], models: ['v4'],
          source: 'pi', modelThinking: {}, modelConnections: {},
        },
      ],
      piPending: false,
      thinkingLevels: { claude: ['low'], pi: ['off'] },
    }),
  };
  const snapshot = await handleModelsCatalog(DEPS, {}, catalog);
  assert.deepEqual(snapshot.routes.map((route) => [route.endpoint, route.backend, route.provider]), [
    ['anthropic', 'claude', null],
    ['deepseek', 'pi', 'deepseek'],
  ]);
  assert.deepEqual(snapshot.routes[0].modelConnections, { qwen: ['qwen-ksu'], opus: ['subscription'] });
  assert.deepEqual(snapshot.routes[0].modelThinking, { opus: ['low'] });
  assert.equal(snapshot.piPending, false);
  assert.deepEqual(snapshot.thinkingLevels, { claude: ['low'], pi: ['off'] });
});
