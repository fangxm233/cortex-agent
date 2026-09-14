// input:  PIAdapter over a fake PI runtime that exposes the mid-turn compaction surface
// output: guard installation on a live session and turn transparency of a mid-turn compaction
// pos:    PI mid-turn compaction wiring regression on the EngineSession seam
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { engineSpecFixture } from '../engine-spec-fixture.js';

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import { piPool } from './pi-pool-fixture.js';
import { updateSettings } from '@core/settings.js';
import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';
import type { GuardPrepareNextTurn } from '../../src/agent-adapter/pi/context-guard.js';
import {
  makeFakeRuntimeFactory, type FakeRuntime, type FakeRuntimeFactoryOptions,
} from './pi-fake-runtime.js';

let counter = 0;

async function openTurn(options: FakeRuntimeFactoryOptions) {
  const fake = makeFakeRuntimeFactory(options);
  const adapter = new PIAdapter(fake.factory);
  const engine = piPool(adapter).open(engineSpecFixture({
    sessionId: null, sessionKey: `pi-midturn-${counter++}`, resume: false,
  }));
  const raw: NormalizedEvent[] = [];
  const run = engine.run({ text: 'opening' }, {
    awaitBackground: 'none', onNormalizedEvent: (event) => raw.push(event),
  });
  void run.result.catch(() => undefined);
  const drained = (async () => { for await (const _event of run.events) { /* drain */ } })();
  const runtime = await fake.runtime(0);
  await runtime.nextCall('prompt');
  return { engine, run, runtime, raw, drained };
}

/** The hook the guard installed on the fake session, or undefined when it stayed out. */
function nextTurnHook(runtime: FakeRuntime): GuardPrepareNextTurn | undefined {
  return (runtime.session as unknown as {
    agent?: { prepareNextTurnWithContext?: GuardPrepareNextTurn };
  }).agent?.prepareNextTurnWithContext;
}

const TOOL_TURN = {
  message: { content: [{ type: 'toolCall', id: 't1', name: 'bash' }] },
  context: { systemPrompt: 'base', messages: ['stale'] },
};

test('a mid-turn compaction runs on the live session and still leaves one Cortex turn', async (t) => {
  await updateSettings({ piMidTurnCompactPercent: 88 });
  t.onTestFinished(async () => { await updateSettings({ piMidTurnCompactPercent: 88 }); });
  const { engine, run, runtime, raw, drained } = await openTurn({
    contextGuard: { percent: 93 },
  });
  t.onTestFinished(() => engine.close());

  runtime.emitAgentStart();
  const hook = nextTurnHook(runtime);
  assert.ok(hook, 'the guard installs itself on a session that exposes the PI hooks');
  const update = await hook(TOOL_TURN, undefined);
  assert.deepEqual(runtime.autoCompactions, [{ reason: 'threshold', willRetry: false }]);
  assert.deepEqual((update?.context as { messages: unknown[] }).messages,
    [{ role: 'user' }, { role: 'toolResult' }]);

  // PI never settled in between, so the compaction is invisible to the run: one terminal event.
  runtime.emitAgentEnd({ usage: { cost: { total: 0.02 } } });
  const result = await run.result;
  await drained;
  assert.equal(result.num_turns, 1);
  assert.equal(raw.filter((event) => event.type === 'turn_complete').length, 1);
});

test('the trigger percent is read per check, so 0 disables it on a pooled session', async (t) => {
  await updateSettings({ piMidTurnCompactPercent: 0 });
  t.onTestFinished(async () => { await updateSettings({ piMidTurnCompactPercent: 88 }); });
  const { engine, run, runtime, drained } = await openTurn({ contextGuard: { percent: 99 } });
  t.onTestFinished(() => engine.close());

  runtime.emitAgentStart();
  const hook = nextTurnHook(runtime);
  assert.ok(hook);
  assert.equal(await hook(TOOL_TURN, undefined), undefined);
  assert.deepEqual(runtime.autoCompactions, []);

  runtime.emitAgentEnd({ usage: { cost: { total: 0.01 } } });
  await run.result;
  await drained;
});

test('a session without the PI compaction surface runs unguarded', async (t) => {
  const { engine, run, runtime, drained } = await openTurn({});
  t.onTestFinished(() => engine.close());
  assert.equal(nextTurnHook(runtime), undefined);
  runtime.emitAgentStart();
  runtime.emitAgentEnd({ usage: { cost: { total: 0.01 } } });
  await run.result;
  await drained;
});
