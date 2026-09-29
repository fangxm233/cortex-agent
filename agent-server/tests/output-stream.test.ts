import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { SlackOutputStream, _testSetRetryDelays, _testResetRetryDelays } from '../src/platform/adapters/slack-output-stream.js';
import { FeishuOutputStream } from '../src/platform/adapters/feishu-output-stream.js';
import { MockAdapter } from '../src/platform/testing.js';
import type { Destination } from '../src/platform/types.js';

// =========================================================================
// Helpers
// =========================================================================

function testDest(channel: string): Destination {
  return { type: 'interactive-reply', conduit: channel, sessionId: '' };
}

function slackStream(adapter: MockAdapter, dest?: Destination, opts?: any): SlackOutputStream {
  return new SlackOutputStream(adapter as any, dest ?? testDest('C123'), opts);
}

function feishuStream(adapter: MockAdapter, dest?: Destination, opts?: any): FeishuOutputStream {
  return new FeishuOutputStream(adapter as any, dest ?? testDest('C124'), opts);
}

beforeEach(() => { _testSetRetryDelays([0, 0, 0, 0]); });
afterEach(() => { _testResetRetryDelays(); });

// =========================================================================
// SlackOutputStream tests
// =========================================================================

test('SlackOutputStream: second table forces new message', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('intro\n| a | b |\n| 1 | 2 |');
  stream.emitText('more\n| c | d |\n| 3 | 4 |');
  await stream.flush();

  assert.equal(adapter.posted.length, 2);
});

test('SlackOutputStream: 3rd HR forces new message', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('a\n---\nb');
  stream.emitText('c\n---\nd');
  stream.emitText('e\n---\nf');
  await stream.flush();

  assert.equal(adapter.posted.length, 2);
});

// --- Retry behavior ---

test('SlackOutputStream: zero-delay retries do not schedule a wall-clock timer', async () => {
  const timer = vi.spyOn(globalThis, 'setTimeout');
  _testSetRetryDelays([0, 0, 0, 0]);
  const adapter = new MockAdapter();
  adapter.failPostMessageCount = 3;
  const stream = slackStream(adapter);
  stream.emitText('zero-delay retry');
  await stream.flush();
  assert.equal(timer.mock.calls.length, 0, 'zero-delay retries must not schedule a timer');
  assert.equal(adapter.posted.length, 1, 'message still reaches adapter after retries');
});

// --- MutableRegion ---

test('SlackOutputStream: openMutable creates editable region', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('committed');
  const region = stream.openMutable('tail');
  region.update('updated tail');
  await stream.flush();

  // emitText → post; openMutable → update; region.update → update
  // MockAdapter: 1 post (committed), 2 updates (tail → updated tail)
  assert.equal(adapter.posted.length, 1, 'first emitText posts');
  assert.equal(adapter.updated.length, 2, 'two updates: openMutable + region.update');
  // The final update should show committed + updated tail
  const lastUpdate = adapter.updated[adapter.updated.length - 1].content.text;
  assert.ok(lastUpdate.includes('committed'), 'committed text present');
  assert.ok(lastUpdate.includes('updated tail'), 'updated tail present');
});

test('SlackOutputStream: stale region update is no-op after emitText', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  const region = stream.openMutable('initial tail');
  stream.emitText('committed');
  region.update('stale update — should be no-op');
  await stream.flush();

  // emitText causes 1 update (combining tail+committed).
  // The stale region update must NOT cause a second update.
  assert.equal(adapter.updated.length, 1, 'stale region update is no-op — only append causes update');
});

test('SlackOutputStream: stale region update is no-op after second openMutable', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  const regionA = stream.openMutable('first tail');
  const regionB = stream.openMutable('second tail');
  regionA.update('stale — should be no-op');
  await stream.flush();

  // Multiple updates happened, but regionA's update should be no-op'd.
  // With zerod retries and MockAdapter's serial behavior, the last
  // update visible should be from regionB.
  const lastUpdate = adapter.updated[adapter.updated.length - 1];
  assert.ok(lastUpdate.content.text.includes('second tail'));
  assert.ok(!lastUpdate.content.text.includes('stale'));
});

test('SlackOutputStream: openMutable empty text returns no-op region', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  const region = stream.openMutable('');
  region.update('this should not post');
  await stream.flush();

  // No update should happen
  assert.equal(adapter.updated.length, 0);
});

test('SlackOutputStream: postInteractive seals mutable region', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  const region = stream.openMutable('tail before interactive');
  const interactiveRef = await stream.postInteractive('interactive msg');
  const beforeCount = adapter.updated.length;
  region.update('stale after interactive');
  await stream.flush();

  assert.ok(interactiveRef);
  // The stale update should be a no-op
  assert.equal(adapter.updated.length, beforeCount, 'region update after postInteractive is no-op');
});

// =========================================================================
// FeishuOutputStream tests
// =========================================================================

test('FeishuOutputStream: exceeding maxMessageLength forces chunks', async () => {
  const adapter = new MockAdapter({ maxMessageLength: 100 });
  const stream = feishuStream(adapter);
  stream.emitText('x'.repeat(80));
  stream.emitText('y'.repeat(80));
  await stream.flush();

  // Coalescing the two 80-char emits exceeds the 100-char limit, so the stream
  // splits the content across two messages (the overflow threads under the first).
  assert.equal(adapter.posted.length, 2);
});

test('FeishuOutputStream: postInteractive delegates to adapter', async () => {
  const adapter = new MockAdapter();
  const stream = feishuStream(adapter);
  const ref = await stream.postInteractive('interactive msg', {
    actions: [{ type: 'button', text: 'Go', actionId: 'go', value: 'yes' }],
  });
  await stream.flush();

  assert.ok(ref);
  assert.equal(adapter.posted.length, 1, 'postInteractive posts a message');
  assert.ok(adapter.posted[0].actions, 'actions included');
  assert.equal(adapter.posted[0].actions![0].actionId, 'go');
});
