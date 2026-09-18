import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  SlackOutputStream,
  _testSetRetryDelays,
  _testResetRetryDelays,
} from '../src/platform/adapters/slack-output-stream.js';
import { MockAdapter } from '../src/platform/testing.js';
import type { SlackAdapter } from '../src/platform/adapters/slack.js';
import type { Destination } from '../src/platform/types.js';
import { postOnce } from '../src/platform/output-stream-helpers.js';

function testDest(channel: string): Destination {
  return { type: 'interactive-reply', conduit: channel, sessionId: '' };
}

function postedConduit(p: { destination: Destination }): string {
  return p.destination.type === 'interactive-reply' ? p.destination.conduit : '';
}

async function flush(stream: SlackOutputStream) {
  await stream.flush();
}

// Retry delays are real setTimeout in production. For the whole test file we
// zero them out so "sustained transient failure" cases exercise the retry
// code path without paying ~6.3s of wall-clock per case. The specific test
// that verifies the zero-delay contract re-sets defaults and then restores.
beforeEach(() => { _testSetRetryDelays([0, 0, 0, 0]); });
afterEach(() => { _testResetRetryDelays(); });

// --- Basic aggregation ---

test('SlackOutputStream: single emitText creates one top-level message', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  stream.emitText('hello');
  await flush(stream);

  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.posted[0].content.text, 'hello');
  assert.equal(postedConduit(adapter.posted[0]), 'C123');
  assert.equal(adapter.posted[0].threadId, undefined, 'first message is top-level');
  assert.equal(adapter.updated.length, 0);
});

test('SlackOutputStream: two short messages — second uses update', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  stream.emitText('first');
  stream.emitText('second');
  await flush(stream);

  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.updated.length, 1);
  assert.equal(adapter.updated[0].content.text, 'first\nsecond');
});

// --- Splitting ---

test('SlackOutputStream: exceeding maxMessageLength forces new message', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  stream.emitText('x'.repeat(2000));
  stream.emitText('y'.repeat(1500));
  await flush(stream);

  assert.equal(adapter.posted.length, 2);
  assert.equal(adapter.updated.length, 0);
});

// --- Thread parent behavior (no external threadId) ---

test('SlackOutputStream: no threadId — first top-level, overflow to thread', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  stream.emitText('x'.repeat(2000));
  stream.emitText('y'.repeat(1500));
  await flush(stream);

  assert.equal(adapter.posted.length, 2);
  assert.equal(adapter.posted[0].threadId, undefined, 'first is top-level');
  assert.equal(adapter.posted[1].threadId, '1000', 'overflow threads under first');
});

test('SlackOutputStream: getParentRef returns full MessageRef', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  stream.emitText('hello');
  await flush(stream);
  const ref = stream.getParentRef();
  assert.ok(ref);
  assert.equal(ref!.conduit, 'C123');
  assert.equal(ref!.messageId, '1000');
});

test('SlackOutputStream: multiple splits all go to thread under first', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  stream.emitText('x'.repeat(2000));
  stream.emitText('y'.repeat(1500));
  stream.emitText('z'.repeat(1500));
  await flush(stream);

  assert.equal(adapter.posted.length, 3);
  assert.equal(adapter.posted[0].threadId, undefined);
  assert.equal(adapter.posted[1].threadId, '1000');
  assert.equal(adapter.posted[2].threadId, '1000');
});

// --- External threadId behavior ---

test('SlackOutputStream: with threadId — all messages use it', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'), { threadId: '999.000' });
  stream.emitText('x'.repeat(2000));
  stream.emitText('y'.repeat(1500));
  await flush(stream);

  assert.equal(adapter.posted.length, 2);
  assert.equal(adapter.posted[0].threadId, '999.000');
  assert.equal(adapter.posted[1].threadId, '999.000');
});

test('SlackOutputStream: with threadId — no parentRef set', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'), { threadId: '999.000' });
  stream.emitText('hello');
  await flush(stream);
  assert.equal(stream.getParentRef(), null);
});

// --- Callbacks ---

test('SlackOutputStream: onMessagePosted called on post, not update', async () => {
  const adapter = new MockAdapter();
  const refs: any[] = [];
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'), {
    onMessagePosted: (ref) => refs.push(ref),
  });
  stream.emitText('first');
  stream.emitText('second');
  await flush(stream);

  assert.equal(refs.length, 1);
  assert.equal(refs[0].messageId, '1000');
});

test('SlackOutputStream: empty/whitespace text ignored', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  stream.emitText('');
  stream.emitText('   ');
  stream.emitText('\n');
  await flush(stream);

  assert.equal(adapter.posted.length, 0);
  assert.equal(adapter.updated.length, 0);
});

// --- Serialization ---

test('SlackOutputStream: rapid emitText calls processed in order', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  stream.emitText('msg1');
  stream.emitText('msg2');
  stream.emitText('msg3');
  stream.emitText('msg4');
  stream.emitText('msg5');
  await flush(stream);

  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.updated.length, 4);
  const finalText = adapter.updated[3].content.text;
  assert.ok(finalText.includes('msg1'));
  assert.ok(finalText.includes('msg5'));
});

test('SlackOutputStream: char limit split with correct threading', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  stream.emitText('x'.repeat(2000));
  stream.emitText('y'.repeat(1500));
  stream.emitText('z'.repeat(500));
  await flush(stream);

  assert.equal(adapter.posted.length, 2);
  assert.equal(adapter.posted[0].threadId, undefined);
  assert.equal(adapter.posted[1].threadId, '1000');
  assert.equal(adapter.updated.length, 1);
});

// --- postInteractive ---

test('SlackOutputStream: postInteractive creates independent message', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  stream.emitText('content');
  const ref = await stream.postInteractive('standalone text');
  await flush(stream);

  assert.equal(adapter.posted.length, 2);
  assert.ok(ref);
  assert.equal(ref!.messageId, '1001');
});

test('SlackOutputStream: postInteractive resets current, next emitText creates new', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  stream.emitText('before');
  await stream.postInteractive('standalone');
  stream.emitText('after');
  await flush(stream);

  assert.equal(adapter.posted.length, 3);
});

test('SlackOutputStream: postInteractive with actions routes to postInteractive and still splits', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  stream.emitText('A');
  stream.emitText('B');
  const ref = await stream.postInteractive('Form', {
    richBlocks: [{ type: 'section', text: 'Approve?' }],
    actions: [{ type: 'button', text: 'Approve', actionId: 'approve', value: 'yes' }],
  });
  stream.emitText('C');
  await flush(stream);

  // 3 posts: A+B aggregated → form → C; plus updateMessage for B aggregation
  assert.equal(adapter.posted.length, 3);
  assert.equal(adapter.posted[0].content.text, 'A');
  assert.deepEqual(adapter.updated[0].content.text, 'A\nB');

  // Form uses postInteractive path (actions recorded by MockAdapter)
  const formPost = adapter.posted[1];
  assert.equal(formPost.content.text, 'Form');
  assert.ok(formPost.actions, 'form post captured actions (postInteractive path)');
  assert.equal(formPost.actions!.length, 1);
  assert.equal(formPost.actions![0].actionId, 'approve');

  // Post-form emitText must create a new message, NOT merge back into A+B
  assert.equal(adapter.posted[2].content.text, 'C');
  // updateMessage was only used for the pre-form aggregation, never for C
  assert.equal(adapter.updated.length, 1);

  assert.ok(ref);
});

// --- postOnce ---

test('postOnce: creates single message and returns ref', async () => {
  const adapter = new MockAdapter();
  const ref = await postOnce(adapter, testDest('C123'), 'one-shot');

  assert.ok(ref);
  assert.equal(ref!.messageId, '1000');
  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.posted[0].content.text, 'one-shot');
});

// --- Platform capability: custom maxMessageLength ---

test('SlackOutputStream: respects adapter maxMessageLength', async () => {
  const adapter = new MockAdapter({ maxMessageLength: 100 });
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  stream.emitText('x'.repeat(80));
  stream.emitText('y'.repeat(80));
  await flush(stream);

  assert.equal(adapter.posted.length, 2, 'split at 100 char limit, not 3000');
});

// --- MockAdapter tests ---

// --- Regression: silent message drops on transient adapter failures ---
// These tests guard against the bug where a single Slack API failure
// (rate limit, network blip) silently drops a message because errors
// were swallowed without retry or fallback in SlackOutputStream.

test('SlackOutputStream: sustained postMessage failure is retried (rich+plain+retries), message reaches Slack', async () => {
  const adapter = new MockAdapter();
  // Simulate a sustained transient failure: 3 failures across rich attempt,
  // plain attempt, and the first retry. The retry path must eventually succeed.
  adapter.failPostMessageCount = 3;
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  stream.emitText('important content that must not be dropped');
  await flush(stream);

  assert.equal(adapter.posted.length, 1, 'message must reach Slack after retries');
  assert.equal(adapter.posted[0].content.text, 'important content that must not be dropped');
});

test('SlackOutputStream: sustained updateMessage failure does not silently drop emitted text', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  stream.emitText('first');
  await flush(stream);
  assert.equal(adapter.posted.length, 1);

  // Simulate a sustained Slack rate-limit covering BOTH the rich attempt and the
  // plain-text fallback.
  adapter.failUpdateMessageCount = 99; // enough to fail every attempt
  stream.emitText('second');
  await flush(stream);
  adapter.failUpdateMessageCount = 0;

  // Now emitText a third message large enough to trigger needsSplit → _postNew.
  stream.emitText('z'.repeat(3500));
  await flush(stream);

  const visible = reconstructVisibleText(adapter);
  assert.ok(
    visible.includes('first'),
    `'first' must be visible. Visible (first 200): ${visible.slice(0, 200)}`
  );
  assert.ok(
    visible.includes('second'),
    `'second' must NOT be silently dropped after sustained update failure. Visible (first 200): ${visible.slice(0, 200)}`
  );
});

test('SlackOutputStream: chunk[0] sustained failure does not orphan chunk[1] as top-level message', async () => {
  const adapter = new MockAdapter();
  // Sustained failure on chunk[0] only: rich + plain both fail, but retries succeed.
  adapter.failPostMessageCount = 2;
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  // Force chunking into 2 chunks.
  stream.emitText('a'.repeat(2500) + '\n' + 'b'.repeat(2500));
  await flush(stream);

  // After fix: parentRef is established (chunk[0] succeeded via retry),
  // both chunks visible, second chunk is in thread.
  assert.equal(adapter.posted.length, 2, 'both chunks must reach Slack');
  assert.equal(adapter.posted[0].threadId, undefined, 'first chunk top-level');
  assert.equal(
    adapter.posted[1].threadId,
    '1000',
    'second chunk must be a thread reply, not orphaned at top level'
  );
});

test('SlackOutputStream: persistent failure surfaces error to flush() instead of silently passing', async () => {
  const adapter = new MockAdapter();
  // Force every attempt (including all retries) to fail.
  adapter.failPostMessageCount = 999;
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));
  stream.emitText('this should fail loudly, not silently');

  // flush() must reject so callers know the message did not reach Slack.
  await assert.rejects(
    () => stream.flush(),
    /post|message|fail/i,
    'flush() must reject when a message permanently fails to send'
  );
});

test('SlackOutputStream.postInteractive: persistent failure rejects the returned promise', async () => {
  const adapter = new MockAdapter();
  adapter.failPostMessageCount = 999;
  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C123'));

  await assert.rejects(
    () => stream.postInteractive('critical message'),
    /post|standalone|fail/i,
    'postInteractive must reject on persistent failure, not resolve null'
  );
});

// --- DurableHooks integration ---

test('SlackOutputStream: durable hooks called on post and update', async () => {
  const adapter = new MockAdapter();
  const walOps: { op: string; channel?: string; text?: string; walId?: string; messageId?: string }[] = [];
  let walCounter = 0;
  const durable = {
    async beforePost(_dest: unknown, text: string) {
      const id = `wal-${++walCounter}`;
      walOps.push({ op: 'beforePost', text, walId: id });
      return id;
    },
    async beforeUpdate(channel: string, messageId: string, text: string) {
      const id = `wal-${++walCounter}`;
      walOps.push({ op: 'beforeUpdate', channel, messageId, text, walId: id });
      return id;
    },
    async afterSent(walId: string, slackTs?: string) {
      walOps.push({ op: 'afterSent', walId, messageId: slackTs });
    },
  };

  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C-durable'), { durable });
  stream.emitText('first');
  stream.emitText('second');
  await flush(stream);

  // first → beforePost → adapter.postMessage → afterSent
  // second → beforeUpdate → adapter.updateMessage → afterSent
  assert.equal(walOps.length, 4);
  assert.equal(walOps[0].op, 'beforePost');
  assert.equal(walOps[0].text, 'first');
  assert.equal(walOps[1].op, 'afterSent');
  assert.equal(walOps[1].walId, 'wal-1');
  assert.equal(walOps[2].op, 'beforeUpdate');
  assert.ok(walOps[2].text!.includes('first'));
  assert.ok(walOps[2].text!.includes('second'));
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

  const stream = new SlackOutputStream(adapter as unknown as SlackAdapter, testDest('C-standalone'), { durable });
  await stream.postInteractive('standalone text');
  await flush(stream);

  assert.deepEqual(walOps, ['beforePost', 'afterSent']);
});

/**
 * Helper: reconstruct what Slack would actually display by applying all updates
 * (last update per messageId wins) to the posted content.
 */
function reconstructVisibleText(adapter: MockAdapter): string {
  const lastByRef = new Map<string, string>();
  for (const p of adapter.posted) {
    lastByRef.set(`${postedConduit(p)}:${(p as any).messageId ?? ''}`, p.content.text || '');
  }
  // Posted captures the initial text; updates overwrite. Track by index since
  // MockAdapter doesn't store messageId on PostedMessage — use posted order.
  const texts: string[] = adapter.posted.map(p => p.content.text || '');
  for (const u of adapter.updated) {
    // updated.ref.messageId starts at '1000' and increments per post.
    const idx = parseInt(u.ref.messageId, 10) - 1000;
    if (idx >= 0 && idx < texts.length) {
      texts[idx] = u.content.text || '';
    }
  }
  return texts.join('\n---\n');
}
