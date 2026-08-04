// input:  createAndSend handler, PI adapter, deferred discovery
// output: fresh PI session response and event-loop ordering regression
// pos:    Proves slow PI discovery cannot hide a fresh Web message
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import type {
  ChildProcess, ChildProcessWithoutNullStreams, SpawnOptions,
} from 'node:child_process';
import type { AgentProcessSpawner } from '../../../src/agent-adapter/types.js';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'vitest';

import { PIAdapter } from '../../../src/agent-adapter/pi/adapter.js';
import { PI_MODELS_PATH, PI_SESSIONS_DIR } from '../../../src/agent-adapter/pi/agent-dir.js';
import { createPIProviderDiscovery } from '../../../src/agent-adapter/pi/discovery.js';
import type { PIAgentProcess } from '../../../src/agent-adapter/pi/session-support.js';
import { handleCreateAndSend } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

interface StubChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
}

function makeStubChild(): StubChild {
  const child = new EventEmitter() as StubChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

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
  const child = makeStubChild();
  const spawner: AgentProcessSpawner = (_cmd, _args, _opts) => {
    timeline.push('pi-spawn');
    return { process: child as unknown as ChildProcessWithoutNullStreams };
  };
  const adapter = new PIAdapter(spawner, PI_SESSIONS_DIR, discovery);
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

    assert.deepEqual(response, { ok: true, data: { sessionId: 'session-new' } });
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
    child.emit('close', 0, null);
    await agentProcess?.close();
  }
});
