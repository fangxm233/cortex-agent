import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SYNTHETIC_CALLBACK_SENDER } from '../../src/platform/types.js';
import { WEB_UI_SENDER, buildWebUserMessage, sendWebUserMessage } from '../../src/orchestration/session-send.js';

test('buildWebUserMessage builds a GENUINE user turn (senderId != synthetic callback)', () => {
  const m = buildWebUserMessage('C123', 'run the probe');
  assert.equal(m.kind, 'user');
  assert.equal(m.isBot, false);
  assert.equal(m.text, 'run the probe');
  assert.equal(m.ref.conduit, 'C123');
  assert.notEqual(m.senderId, SYNTHETIC_CALLBACK_SENDER);
  assert.equal(m.senderId, WEB_UI_SENDER);
});

test('sendWebUserMessage routes a genuine user message with the right ctx (fire-and-forget)', async () => {
  const calls: any[] = [];
  const adapter = { name: 'mock' } as any;
  sendWebUserMessage({
    channel: 'C123',
    text: 'hello',
    adapter,
    route: async (ctx) => { calls.push(ctx); },
  });
  // fire-and-forget — allow the microtask to run
  await Promise.resolve();

  assert.equal(calls.length, 1);
  const ctx = calls[0];
  assert.equal(ctx.channel, 'C123');
  assert.equal(ctx.adapter, adapter);
  assert.equal(ctx.threadAnchorId, null);
  assert.equal(ctx.hasFiles, false);
  assert.equal(ctx.userMessage, 'hello');
  assert.equal(ctx.agentMessage, 'hello');
  assert.equal(ctx.message.senderId, WEB_UI_SENDER);
  assert.equal(ctx.message.text, 'hello');
});
