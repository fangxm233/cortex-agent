import { engineSpecFixture } from '../../engine-spec-fixture.js';


import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { PIAdapter } from '../../../src/agent-adapter/pi/adapter.js';
import { piPool } from '../../agent-adapter/pi-pool-fixture.js';
import { PI_AGENT_DIR, PI_SESSIONS_DIR, piModelsPath } from '../../../src/agent-adapter/pi/defaults.js';
import { createPIProviderDiscovery } from '../../../src/agent-adapter/pi/discovery.js';
import type { PiDiscoveredModel } from '../../../src/core/gateway-generator.js';
import type { PiRuntimeFactory } from '../../../src/agent-adapter/pi/runtime.js';
import type { PIEngineSession } from '../../../src/agent-adapter/pi/engine.js';
import { handleCreateAndSend } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import { makeFakeRuntimeFactory } from '../../agent-adapter/pi-fake-runtime.js';
import { upsertConnection } from '../../../src/core/connections-file.js';
import { buildPiCatalog } from '../../../src/domain/connections/pi-catalog.js';
import { readRuntimeKeys } from '../../../src/agent-adapter/pi/providers-config.js';

test('fresh PI createAndSend responds and exposes the user event without consulting slow discovery', async () => {
  let scans = 0;
  // A scan that never answers: the spawn path writes its catalog from connections, not discovery.
  const discovery = createPIProviderDiscovery({
    scan: () => {
      scans += 1;
      return new Promise<PiDiscoveredModel[]>(() => {});
    },
  });
  const timeline: string[] = [];
  const fake = makeFakeRuntimeFactory();
  // The session invokes its runtime factory synchronously inside open(), so this marker lands
  // exactly where the PI session is created relative to the response and the user event.
  const factory: PiRuntimeFactory = (request, callbacks) => {
    timeline.push('pi-spawn');
    return fake.factory(request, callbacks);
  };
  // The catalog the session runs with comes from a PI connection: anthropic behind a relay URL.
  const connections = path.join(mkdtempSync(path.join(os.tmpdir(), 'pi-create-')), 'connections.json');
  upsertConnection({
    id: 'anthropic', backend: 'pi', provider: 'anthropic', baseUrl: 'https://relay.example.test', key: 'fake-relay-key',
  }, connections);
  const catalog = () => buildPiCatalog({ file: connections, userModelsPath: null });
  const adapter = new PIAdapter(factory, PI_SESSIONS_DIR, discovery, { catalog });
  let engine: PIEngineSession | null = null;
  let markVisible!: () => void;
  const visible = new Promise<void>((resolve) => { markVisible = resolve; });
  const deps = {
    createDirectSession: async () => ({
      sessionId: 'session-new',
      channel: 'web:session-new',
    }),
    sendSessionMessage: () => {
      timeline.push('user-event-published');
      setImmediate(() => {
        timeline.push('user-event-visible');
        markVisible();
      });
      engine = piPool(adapter).open(engineSpecFixture({
        sessionId: null,
        sessionKey: 'fresh-web-pi',
        resume: false,
        model: 'claude-sonnet-4-6',
        piProvider: 'anthropic',
      }));
    },
  } as unknown as UiServiceDeps;

  try {
    const response = await handleCreateAndSend(deps, {
      projectId: 'nimbus',
      selection: { backend: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-6', thinking: null, connection: null },
      text: 'hello',
    });
    timeline.push('response');
    await visible;

    assert.equal(response.ok, true);
    if (response.ok) {
      assert.equal(response.data.sessionId, 'session-new');
      assert.match(response.data.acceptedAt, /^\d{4}-\d{2}-\d{2}T/);
    }
    assert.deepEqual(timeline, [
      'user-event-published',
      'pi-spawn',
      'response',
      'user-event-visible',
    ]);
    assert.equal(scans, 0, 'neither the response nor the spawn consults discovery');

    const models = JSON.parse(readFileSync(piModelsPath(PI_AGENT_DIR), 'utf8'));
    assert.deepEqual(Object.keys(models.providers), ['anthropic']);
    assert.equal(models.providers.anthropic.baseUrl, 'https://relay.example.test');
    assert.deepEqual(readRuntimeKeys(PI_AGENT_DIR), { anthropic: 'fake-relay-key' });
  } finally {
    await engine?.close();
    await piPool(adapter).close('fresh-web-pi');
  }
});
