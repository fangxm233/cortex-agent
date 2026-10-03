import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Orchestrator } from '../../src/orchestration/orchestrator.js';
import type { OrchMessageContext } from '../../src/orchestration/orchestrator.js';

function makeCtx(overrides: Partial<OrchMessageContext> = {}): OrchMessageContext {
  return {
    message: { ref: { channel: 'C1', messageId: 'M1', threadId: null }, text: 'hello', isBot: false, files: [], subtype: undefined } as any,
    channel: 'C1',
    adapter: {} as any,
    threadAnchorId: null,
    hasFiles: false,
    userMessage: 'hello',
    agentMessage: 'hello',
    ...overrides,
  };
}

test('every routed message goes to the agent runner, context unchanged', async () => {
  const calls: unknown[] = [];
  const orch = new Orchestrator({ agentRunner: { async route(ctx: any) { calls.push(ctx); } } });

  const ctx = makeCtx({ userMessage: '!thread review fix the bug' });
  await orch.handleMessage(ctx);

  assert.deepEqual(calls, [ctx]);
});
