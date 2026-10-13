import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import type { PiHostCollaborators, PiRuntimeFactory } from '../../src/agent-adapter/pi/runtime.js';
import { engineSpecFixture } from '../engine-spec-fixture.js';
import { makeFakeRuntimeFactory } from './pi-fake-runtime.js';

test.each([true, false])('adapter and session preserve the optional host snapshot getter (injected=%s)', async injected => {
  const fake = makeFakeRuntimeFactory();
  const getter = vi.fn(() => ({ CORTEX_SUBAGENT_PI_MODELS: '[]' }));
  let received: PiHostCollaborators | undefined;
  const factory: PiRuntimeFactory = (request, callbacks, collaborators) => {
    received = collaborators;
    return fake.factory(request, callbacks);
  };
  const root = process.env.CORTEX_HOME!;
  const adapter = new PIAdapter(factory, join(root, 'catalog-sessions'), undefined, {
    agentDir: join(root, 'catalog-agent'),
    ...(injected ? { getSubagentModelEnv: getter } : {}),
  });
  const engine = adapter.open(engineSpecFixture({ sessionKey: 'catalog', mcpComposition: 'none' }));
  try {
    await fake.runtime();
    assert.equal(received?.getSubagentModelEnv, injected ? getter : undefined);
    assert.equal(getter.mock.calls.length, 0, 'the extension setup owns the single snapshot read');
  } finally { await engine.close(); }
});
