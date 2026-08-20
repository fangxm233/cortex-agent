// input:  Vitest, SlackOutputStream, FeishuOutputStream, MockAdapter
// output: Slack and Feishu output-stream behavior regressions
// pos:    Covers batching, retries, mutable regions, and message references
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { SlackOutputStream, _testSetRetryDelays, _testResetRetryDelays } from '../src/platform/adapters/slack-output-stream.js';
import { FeishuOutputStream } from '../src/platform/adapters/feishu-output-stream.js';
import { MockAdapter } from '../src/platform/testing.js';
import type { Destination, MessageRef } from '../src/platform/types.js';

// =========================================================================
// Helpers
// =========================================================================

function testDest(channel: string): Destination {
  return { type: 'interactive-reply', conduit: channel, sessionId: '' };
}

function postedConduit(p: { destination: Destination }): string {
  return p.destination.type === 'interactive-reply' ? p.destination.conduit : '';
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

test('SlackOutputStream: single emitText creates one top-level message', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('hello');
  await stream.flush();

  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.posted[0].content.text, 'hello');
  assert.equal(postedConduit(adapter.posted[0]), 'C123');
  assert.equal(adapter.posted[0].threadId, undefined, 'first message is top-level');
  assert.equal(adapter.updated.length, 0);
});

test('SlackOutputStream: two emitTexts — second uses update', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('first');
  stream.emitText('second');
  await stream.flush();

  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.updated.length, 1);
  assert.equal(adapter.updated[0].content.text, 'first\nsecond');
});

test('SlackOutputStream: three emitTexts all aggregate', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('one');
  stream.emitText('two');
  stream.emitText('three');
  await stream.flush();

  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.updated.length, 2);
  const finalText = adapter.updated[1].content.text;
  assert.ok(finalText.includes('one'));
  assert.ok(finalText.includes('two'));
  assert.ok(finalText.includes('three'));
});

test('SlackOutputStream: exceeding maxMessageLength forces new message', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('x'.repeat(2000));
  stream.emitText('y'.repeat(1500));
  await stream.flush();

  assert.equal(adapter.posted.length, 2);
  assert.equal(adapter.updated.length, 0);
});

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

test('SlackOutputStream: no threadId — first top-level, overflow to thread', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('x'.repeat(2000));
  stream.emitText('y'.repeat(1500));
  await stream.flush();

  assert.equal(adapter.posted.length, 2);
  assert.equal(adapter.posted[0].threadId, undefined, 'first is top-level');
  assert.equal(adapter.posted[1].threadId, '1000', 'overflow threads under first');
});

test('SlackOutputStream: getParentRef returns first message ref', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  assert.equal(stream.getParentRef(), null);
  stream.emitText('hello');
  await stream.flush();
  const ref = stream.getParentRef();
  assert.ok(ref);
  assert.equal(ref!.conduit, 'C123');
  assert.equal(ref!.messageId, '1000');
});

test('SlackOutputStream: multiple splits all go to thread under first', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('x'.repeat(2000));
  stream.emitText('y'.repeat(1500));
  stream.emitText('z'.repeat(1500));
  await stream.flush();

  assert.equal(adapter.posted.length, 3);
  assert.equal(adapter.posted[0].threadId, undefined);
  assert.equal(adapter.posted[1].threadId, '1000');
  assert.equal(adapter.posted[2].threadId, '1000');
});

test('SlackOutputStream: with threadId — all messages use it', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter, testDest('C123'), { threadId: '999.000' });
  stream.emitText('x'.repeat(2000));
  stream.emitText('y'.repeat(1500));
  await stream.flush();

  assert.equal(adapter.posted.length, 2);
  assert.equal(adapter.posted[0].threadId, '999.000');
  assert.equal(adapter.posted[1].threadId, '999.000');
});

test('SlackOutputStream: with threadId — no parentRef set', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter, testDest('C123'), { threadId: '999.000' });
  stream.emitText('hello');
  await stream.flush();
  assert.equal(stream.getParentRef(), null);
});

test('SlackOutputStream: onMessagePosted called on post, not update', async () => {
  const adapter = new MockAdapter();
  const refs: MessageRef[] = [];
  const stream = slackStream(adapter, testDest('C123'), {
    onMessagePosted: (ref) => refs.push(ref),
  });
  stream.emitText('first');
  stream.emitText('second');
  await stream.flush();

  assert.equal(refs.length, 1);
  assert.equal(refs[0].messageId, '1000');
});

test('SlackOutputStream: onMessagePosted called for each new post', async () => {
  const adapter = new MockAdapter();
  const refs: MessageRef[] = [];
  const stream = slackStream(adapter, testDest('C123'), {
    onMessagePosted: (ref) => refs.push(ref),
  });
  stream.emitText('x'.repeat(2000));
  stream.emitText('y'.repeat(1500));
  await stream.flush();

  assert.equal(refs.length, 2);
  assert.equal(refs[0].messageId, '1000');
  assert.equal(refs[1].messageId, '1001');
});

test('SlackOutputStream: empty/whitespace text ignored', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('');
  stream.emitText('   ');
  stream.emitText('\n');
  await stream.flush();

  assert.equal(adapter.posted.length, 0);
  assert.equal(adapter.updated.length, 0);
});

test('SlackOutputStream: getRefs returns all message refs', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('x'.repeat(2000));
  stream.emitText('y'.repeat(1500));
  await stream.flush();

  const refs = stream.getRefs();
  assert.equal(refs.length, 2);
  assert.equal(refs[0].messageId, '1000');
  assert.equal(refs[1].messageId, '1001');
});

test('SlackOutputStream: rapid emitTexts processed in order', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('msg1');
  stream.emitText('msg2');
  stream.emitText('msg3');
  stream.emitText('msg4');
  stream.emitText('msg5');
  await stream.flush();

  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.updated.length, 4);
  const finalText = adapter.updated[3].content.text;
  assert.ok(finalText.includes('msg1'));
  assert.ok(finalText.includes('msg5'));
});

test('SlackOutputStream: char limit split with correct threading', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('x'.repeat(2000));
  stream.emitText('y'.repeat(1500));
  stream.emitText('z'.repeat(500));
  await stream.flush();

  assert.equal(adapter.posted.length, 2);
  assert.equal(adapter.posted[0].threadId, undefined);
  assert.equal(adapter.posted[1].threadId, '1000');
  assert.equal(adapter.updated.length, 1);
});

test('SlackOutputStream: richBlocks included in post and update', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('hello');
  stream.emitText('world');
  await stream.flush();

  assert.ok(adapter.posted[0].content.richBlocks);
  assert.equal(adapter.posted[0].content.richBlocks![0].type, 'markdown');
  assert.ok(adapter.updated[0].content.richBlocks);
  assert.equal(adapter.updated[0].content.richBlocks![0].type, 'markdown');
});

test('SlackOutputStream: postInteractive creates independent message', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('content');
  const ref = await stream.postInteractive('interactive text');
  await stream.flush();

  assert.equal(adapter.posted.length, 2);
  assert.ok(ref);
  assert.equal(ref!.messageId, '1001');
});

test('SlackOutputStream: postInteractive resets current, next emitText creates new', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('before');
  await stream.postInteractive('interactive');
  stream.emitText('after');
  await stream.flush();

  assert.equal(adapter.posted.length, 3);
});

test('SlackOutputStream: postInteractive with actions routes to postInteractive and still splits', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('A');
  stream.emitText('B');
  const ref = await stream.postInteractive('Form', {
    richBlocks: [{ type: 'section', text: 'Approve?' }],
    actions: [{ type: 'button', text: 'Approve', actionId: 'approve', value: 'yes' }],
  });
  stream.emitText('C');
  await stream.flush();

  assert.equal(adapter.posted.length, 3);
  assert.equal(adapter.posted[0].content.text, 'A');
  assert.deepEqual(adapter.updated[0].content.text, 'A\nB');

  const formPost = adapter.posted[1];
  assert.equal(formPost.content.text, 'Form');
  assert.ok(formPost.actions, 'form post captured actions (postInteractive path)');
  assert.equal(formPost.actions!.length, 1);
  assert.equal(formPost.actions![0].actionId, 'approve');

  assert.equal(adapter.posted[2].content.text, 'C');
  assert.equal(adapter.updated.length, 1);

  assert.ok(ref);
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

test('SlackOutputStream: sustained postMessage failure is retried, message reaches adapter', async () => {
  const adapter = new MockAdapter();
  adapter.failPostMessageCount = 3;
  const stream = slackStream(adapter);
  stream.emitText('important content');
  await stream.flush();

  assert.equal(adapter.posted.length, 1, 'message must reach adapter after retries');
  assert.equal(adapter.posted[0].content.text, 'important content');
});

test('SlackOutputStream: persistent failure surfaces error to flush() instead of silent pass', async () => {
  const adapter = new MockAdapter();
  adapter.failPostMessageCount = 999;
  const stream = slackStream(adapter);
  stream.emitText('this should fail loudly');

  await assert.rejects(
    () => stream.flush(),
    /post|message|fail/i,
    'flush() must reject when a message permanently fails to send'
  );
});

test('SlackOutputStream: postInteractive persistent failure rejects the returned promise', async () => {
  const adapter = new MockAdapter();
  adapter.failPostMessageCount = 999;
  const stream = slackStream(adapter);

  await assert.rejects(
    () => stream.postInteractive('critical message'),
    /post|interactive|fail/i,
    'postInteractive must reject on persistent failure'
  );
});

// --- Durable hooks ---

test('SlackOutputStream: durable hooks called on emitText and update', async () => {
  const adapter = new MockAdapter();
  const walOps: { op: string; text?: string; walId?: string }[] = [];
  let walCounter = 0;
  const durable = {
    async beforePost(_dest: unknown, text: string) {
      const id = `wal-${++walCounter}`;
      walOps.push({ op: 'beforePost', text, walId: id });
      return id;
    },
    async beforeUpdate(_channel: string, _messageId: string, text: string) {
      const id = `wal-${++walCounter}`;
      walOps.push({ op: 'beforeUpdate', text, walId: id });
      return id;
    },
    async afterSent(walId: string, _slackTs?: string) {
      walOps.push({ op: 'afterSent', walId });
    },
  };

  const stream = slackStream(adapter, testDest('C-durable'), { durable });
  stream.emitText('first');
  stream.emitText('second');
  await stream.flush();

  assert.equal(walOps.length, 4);
  assert.equal(walOps[0].op, 'beforePost');
  assert.equal(walOps[0].text, 'first');
  assert.equal(walOps[1].op, 'afterSent');
  assert.equal(walOps[1].walId, 'wal-1');
  assert.equal(walOps[2].op, 'beforeUpdate');
  assert.ok(walOps[2].text!.includes('first'));
  assert.equal(walOps[3].op, 'afterSent');
  assert.equal(walOps[3].walId, 'wal-2');
});

test('SlackOutputStream: durable hooks called on postInteractive', async () => {
  const adapter = new MockAdapter();
  const walOps: string[] = [];
  const durable = {
    async beforePost() { walOps.push('beforePost'); return 'w1'; },
    async beforeUpdate() { walOps.push('beforeUpdate'); return 'w2'; },
    async afterSent() { walOps.push('afterSent'); },
  };

  const stream = slackStream(adapter, testDest('C-standalone'), { durable });
  await stream.postInteractive('standalone text');
  await stream.flush();

  assert.deepEqual(walOps, ['beforePost', 'afterSent']);
});

test('SlackOutputStream: no durable hooks works without hooks (backward compat)', async () => {
  const adapter = new MockAdapter();
  const stream = slackStream(adapter);
  stream.emitText('hello');
  await stream.flush();

  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.posted[0].content.text, 'hello');
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

test('FeishuOutputStream: consecutive emitText coalesce into one card', async () => {
  const adapter = new MockAdapter();
  const stream = feishuStream(adapter);
  stream.emitText('first');
  stream.emitText('second');
  await stream.flush();

  // Coalescing parity with Slack: the first emit posts the card, the second
  // patches it rather than posting a new message.
  assert.equal(adapter.posted.length, 1, 'only one card is posted');
  assert.equal(adapter.updated.length, 1, 'second emit patches the card');
  assert.equal(adapter.posted[0].content.text, 'first');
  assert.equal(adapter.updated[0].content.text, 'first\nsecond');
});

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

test('FeishuOutputStream: openMutable patches the card, never posts a new message', async () => {
  const adapter = new MockAdapter();
  const stream = feishuStream(adapter);
  stream.emitText('base');
  const region = stream.openMutable('mutable text');
  region.update('region update');
  await stream.flush();

  // Tool-trace regions render via card patch (im.v1.message.patch), so no extra
  // top-level message is posted — only the single 'base' card.
  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.posted[0].content.text, 'base');
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

test('FeishuOutputStream: getRefs and getParentRef', async () => {
  const adapter = new MockAdapter();
  const stream = feishuStream(adapter);
  stream.emitText('msg1');
  stream.emitText('msg2');
  await stream.flush();

  const refs = stream.getRefs();
  assert.equal(refs.length, 1, 'short emits coalesce into a single card');
  const parent = stream.getParentRef();
  assert.ok(parent);
  assert.equal(parent!.messageId, refs[0].messageId);
});

test('FeishuOutputStream: empty/whitespace text ignored', async () => {
  const adapter = new MockAdapter();
  const stream = feishuStream(adapter);
  stream.emitText('');
  stream.emitText('   ');
  await stream.flush();

  assert.equal(adapter.posted.length, 0);
});
