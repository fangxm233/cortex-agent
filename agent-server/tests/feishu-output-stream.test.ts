// input:  node:test, MockAdapter, FeishuOutputStream
// output: FeishuOutputStream coalescing / mutable-region / threading tests
// pos:    Feishu-specific OutputStream regression test (coalescing parity w/ Slack)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  FeishuOutputStream,
  _testSetRetryDelays,
  _testResetRetryDelays,
} from '../src/platform/adapters/feishu-output-stream.js';
import { MockAdapter } from '../src/platform/testing.js';
import type { Destination } from '../src/platform/types.js';

function testDest(channel: string): Destination {
  return { type: 'interactive-reply', conduit: channel, sessionId: '' };
}

// MockAdapter advertises maxMessageLength via capabilities; FeishuOutputStream
// reads it for chunking. Wrap construction so each test can set a small limit.
function makeStream(adapter: MockAdapter, channel = 'oc_1') {
  return new FeishuOutputStream(adapter as any, testDest(channel));
}

beforeEach(() => { _testSetRetryDelays([0, 0, 0]); });
afterEach(() => { _testResetRetryDelays(); });

test('FeishuOutputStream: single emitText posts one top-level card, no update', async () => {
  const adapter = new MockAdapter();
  const stream = makeStream(adapter);
  stream.emitText('hello');
  await stream.flush();

  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.posted[0].content.text, 'hello');
  assert.equal(adapter.posted[0].threadId, undefined, 'first message is top-level (channel)');
  assert.equal(adapter.updated.length, 0);
});

test('FeishuOutputStream: two short emits coalesce — second is a card patch, not a new post', async () => {
  const adapter = new MockAdapter();
  const stream = makeStream(adapter);
  stream.emitText('first');
  stream.emitText('second');
  await stream.flush();

  assert.equal(adapter.posted.length, 1, 'only one card posted');
  assert.equal(adapter.updated.length, 1, 'second emit patches the card');
  assert.equal(adapter.updated[0].content.text, 'first\nsecond');
});

test('FeishuOutputStream: openMutable + update patches the card (tool-trace path), no extra posts', async () => {
  const adapter = new MockAdapter();
  const stream = makeStream(adapter);
  stream.emitText('answer');
  const region = stream.openMutable('🔧 Bash · ls');
  region.update('🔧 Bash ×2 · ls · cat');
  await stream.flush();

  assert.equal(adapter.posted.length, 1, 'tool trace must NOT post new messages');
  assert.ok(adapter.updated.length >= 2, 'openMutable + update both patch the card');
  const finalText = adapter.updated[adapter.updated.length - 1].content.text;
  assert.ok(finalText.includes('answer'));
  assert.ok(finalText.includes('🔧 Bash ×2'));
});

test('FeishuOutputStream: stale mutable region update is a no-op after emitText seals it', async () => {
  const adapter = new MockAdapter();
  const stream = makeStream(adapter);
  const region = stream.openMutable('🔧 tool');
  stream.emitText('committed'); // seals the region (generation bumped)
  region.update('should be ignored');
  await stream.flush();

  const allText = [...adapter.posted.map(p => p.content.text), ...adapter.updated.map(u => u.content.text)].join('\n');
  assert.ok(!allText.includes('should be ignored'), 'stale region update must be discarded');
});

test('FeishuOutputStream: overflow chunks thread under the first message (Slack-style)', async () => {
  const adapter = new MockAdapter({ maxMessageLength: 20 });
  const stream = makeStream(adapter);
  stream.emitText('aaaa bbbb cccc dddd eeee ffff gggg'); // > 20 chars → splits
  await stream.flush();

  assert.ok(adapter.posted.length >= 2, 'long text splits into multiple messages');
  assert.equal(adapter.posted[0].threadId, undefined, 'first chunk is top-level');
  const rootId = stream.getParentRef()?.messageId;
  assert.ok(rootId, 'parent ref set');
  for (let i = 1; i < adapter.posted.length; i++) {
    assert.equal(adapter.posted[i].threadId, rootId, `chunk ${i} threaded under the first message`);
  }
});

test('FeishuOutputStream: flush surfaces a captured post error', async () => {
  const adapter = new MockAdapter();
  adapter.failPostMessageCount = 99; // exhaust retries
  const stream = makeStream(adapter);
  stream.emitText('will fail');
  await assert.rejects(() => stream.flush());
});
