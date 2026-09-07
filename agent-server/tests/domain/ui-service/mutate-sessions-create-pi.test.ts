// input:  createAndSend handler, PI adapter, deferred discovery
// output: fresh PI session response and event-loop ordering regression
// pos:    Proves slow PI discovery cannot hide a fresh Web message
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

import { PIAdapter } from '../../../src/agent-adapter/pi/adapter.js';
import { PI_MODELS_PATH, PI_SESSIONS_DIR } from '../../../src/agent-adapter/pi/agent-dir.js';
import { createPIProviderDiscovery } from '../../../src/agent-adapter/pi/discovery.js';
import type { PiRuntimeFactory } from '../../../src/agent-adapter/pi/runtime.js';
import type { PIAgentProcess } from '../../../src/agent-adapter/pi/session-support.js';
import { handleCreateAndSend } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import { makeFakeRuntimeFactory } from '../../agent-adapter/pi-fake-runtime.js';

test('fresh PI createAndSend responds and exposes the user event before slow discovery fails', async () => {
  let rejectDiscovery!: (error: Error) => void;
  let discoverySettled = false;
  let scans = 0;
  const slowDiscovery = new Promise<string[]>((_, reject) => { rejectDiscovery = reject; });
  const discovery = createPIProviderDiscovery({
    scan: async () => {
      scans += 1;
      try {
        return await slowDiscovery;
      } finally {
        discoverySettled = true;
      }
    },
  });
  const timeline: string[] = [];
  const fake = makeFakeRuntimeFactory();
  // The session invokes its runtime factory synchronously inside spawn(), so this marker lands
  // exactly where the PI session is created relative to the response and the user event.
  const factory: PiRuntimeFactory = (request, callbacks) => {
    timeline.push('pi-spawn');
    return fake.factory(request, callbacks);
  };
  const adapter = new PIAdapter(factory, PI_SESSIONS_DIR, discovery);
  let agentProcess: PIAgentProcess | null = null;
  let markVisible!: () => void;
  const visible = new Promise<void>((resolve) => { markVisible = resolve; });
  const deps = {
    createDirectSession: async () => ({
      sessionId: 'session-new',
      sessionName: 'cortex-new',
      channel: 'web:session-new',
    }),
    sendSessionMessage: () => {
      timeline.push('user-event-published');
      setImmediate(() => {
        timeline.push('user-event-visible');
        markVisible();
      });
      agentProcess = adapter.spawn({
        sessionId: null,
        sessionKey: 'fresh-web-pi',
        resume: false,
        model: 'claude-sonnet-4-6',
        piProvider: 'anthropic',
        piGatewayBaseUrl: 'http://127.0.0.1:9880',
        piGatewayPath: '/m/default/anthropic',
      });
    },
  } as unknown as UiServiceDeps;

  try {
    const response = await handleCreateAndSend(deps, {
      projectId: 'nimbus',
      profileName: 'pi-default',
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
    assert.equal(scans, 1);
    assert.equal(discoverySettled, false, 'response and visibility do not await discovery');

    const models = JSON.parse(readFileSync(PI_MODELS_PATH, 'utf8'));
    assert.deepEqual(Object.keys(models.providers), ['anthropic']);
    assert.equal(models.providers.anthropic.baseUrl, 'http://127.0.0.1:9880/m/default/anthropic');

    rejectDiscovery(new Error('provider discovery timed out'));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(discoverySettled, true);
  } finally {
    await agentProcess?.close();
    await adapter.close('fresh-web-pi');
  }
});
