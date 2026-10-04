import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Model } from '@earendil-works/pi-ai';

import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import type { RunEvent } from '../../src/agent-adapter/run-events.js';
import { engineSpecFixture } from '../engine-spec-fixture.js';
import { piPool } from './pi-pool-fixture.js';
import { makeFakeRuntimeFactory } from './pi-fake-runtime.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

/** One PI turn whose `read` returns an image, on a model taking `input`; its tool_result event. */
async function readImageOn(input: ('text' | 'image')[], sessionKey: string): Promise<Extract<RunEvent, { type: 'tool_result' }>> {
  const fake = makeFakeRuntimeFactory({ model: { input } as Model<any> });
  const engine = piPool(new PIAdapter(fake.factory))
    .open(engineSpecFixture({ sessionId: null, sessionKey, resume: false }));
  const runtime = await fake.runtime(0);
  const run = engine.run({ text: 'look' }, { awaitBackground: 'none' });
  const events: RunEvent[] = [];
  const done = (async () => { for await (const event of run.events) events.push(event); })();
  await runtime.nextCall('prompt');
  runtime.emitAgentStart();
  runtime.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: '/tmp/a.png' } });
  runtime.emit({
    type: 'tool_execution_end', toolCallId: 'c1', isError: false,
    result: { content: [{ type: 'text', text: 'Read image file' }, { type: 'image', data: PNG, mimeType: 'image/png' }] },
  });
  runtime.emitAgentEnd();
  await run.result;
  await done;
  const result = events.find((event): event is Extract<RunEvent, { type: 'tool_result' }> => event.type === 'tool_result');
  assert.ok(result, 'the read produced a tool_result');
  return result;
}

test('a PI tool result carries its images only when the model takes image input', async () => {
  const seen = await readImageOn(['text', 'image'], 'pi-vision');
  assert.deepEqual(seen.images, [{ mimeType: 'image/png', data: PNG }]);

  const blind = await readImageOn(['text'], 'pi-text-only');
  assert.equal(blind.images, undefined, 'PI never sent the image to a text-only model, so it is not shown');
  assert.equal(blind.content, 'Read image file', 'the text part of the result is untouched');
});
