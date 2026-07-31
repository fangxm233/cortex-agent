// input:  MockAdapter and platform message types
// output: mock contract, recording, and nullable hot-admin tests
// pos:    Verifies MockAdapter platform behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { MockAdapter } from '../src/platform/testing.js';
import type {
  ActionContext,
  MessageContext,
  MessageEditContext,
  ModalSubmitContext,
  Destination,
} from '../src/platform/types.js';

test('MockAdapter capability overrides merge with defaults', () => {
  const adapter = new MockAdapter({ capabilities: { threads: false, maxMessageLength: 50 } });
  assert.equal(adapter.capabilities.threads, false);
  assert.equal(adapter.capabilities.maxMessageLength, 50);
  assert.equal(adapter.capabilities.modals, true);
});

test('MockAdapter supports legacy partial-capability constructor arg (no wrapper object)', () => {
  const adapter = new MockAdapter({ threads: false });
  assert.equal(adapter.capabilities.threads, false);
});

test('postMessage records destination/content/threadId and returns unique ascending messageIds', async () => {
  const adapter = new MockAdapter();
  const dest1: Destination = { type: 'interactive-reply', conduit: 'C1', sessionId: 's1' };
  const dest2: Destination = { type: 'project-report', projectId: 'p1', trigger: 'manual', sessionId: 's1' };
  const ref1 = await adapter.postMessage(dest1, { text: 'hello' });
  const ref2 = await adapter.postMessage(dest2, { text: 'world' }, { threadId: 'T1' });

  assert.equal(adapter.posted.length, 2);
  assert.deepEqual(adapter.posted[0], { destination: dest1, content: { text: 'hello' }, threadId: undefined });
  assert.deepEqual(adapter.posted[1], { destination: dest2, content: { text: 'world' }, threadId: 'T1' });
  assert.equal(ref1.conduit, 'C1');
  assert.ok(ref1.messageId);
  assert.ok(ref2.messageId);
  assert.notEqual(ref1.messageId, ref2.messageId);
  assert.equal(ref2.threadId, 'T1');
});

test('updateMessage and deleteMessage record the affected ref', async () => {
  const adapter = new MockAdapter();
  const ref = await adapter.postMessage({ type: 'interactive-reply', conduit: 'C1', sessionId: '' }, { text: 'x' });
  await adapter.updateMessage(ref, { text: 'y' });
  await adapter.deleteMessage(ref);

  assert.equal(adapter.updated.length, 1);
  assert.deepEqual(adapter.updated[0], { ref, content: { text: 'y' } });
  assert.equal(adapter.deleted.length, 1);
  assert.deepEqual(adapter.deleted[0], { ref });
});

test('postInteractive records actions alongside content', async () => {
  const adapter = new MockAdapter();
  const dest: Destination = { type: 'interactive-reply', conduit: 'C1', sessionId: 's1' };
  const actions = [{ type: 'button' as const, actionId: 'approve', value: 'go', text: 'Go' }];
  const ref = await adapter.postInteractive(dest, { text: 'pick one', actions }, { threadId: 'T1' });

  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.posted[0].actions, actions);
  assert.equal(adapter.posted[0].threadId, 'T1');
  assert.equal(adapter.posted[0].destination, dest);
  assert.equal(ref.conduit, 'C1');
});

test('openModal records every opened modal with triggerId', async () => {
  const adapter = new MockAdapter();
  await adapter.openModal('trigger-1', { callbackId: 'cb-1', title: 'T', fields: [] });
  await adapter.openModal('trigger-2', { callbackId: 'cb-2', title: 'U', fields: [] });
  assert.equal(adapter.modals.length, 2);
  assert.equal(adapter.modals[0].triggerId, 'trigger-1');
  assert.equal(adapter.modals[1].modal.callbackId, 'cb-2');
});

test('markQueued and unmarkQueued record symmetric marker operations', async () => {
  const adapter = new MockAdapter();
  const ref = await adapter.postMessage({ type: 'interactive-reply', conduit: 'C1', sessionId: '' }, { text: 'hi' });
  await adapter.markQueued(ref);
  await adapter.unmarkQueued(ref);

  assert.deepEqual(adapter.marksQueued, [{ ref }]);
  assert.deepEqual(adapter.marksUnqueued, [{ ref }]);
});

test('uploadFile records filePath + opts and downloadFile synthesises localPath', async () => {
  const adapter = new MockAdapter();
  const dest: Destination = { type: 'system-notice' };
  await adapter.uploadFile(dest, '/tmp/a.png', { filename: 'a.png', comment: 'attached' });
  assert.equal(adapter.uploads.length, 1);
  assert.equal(adapter.uploads[0].filePath, '/tmp/a.png');
  assert.equal(adapter.uploads[0].destination, dest);
  assert.equal(adapter.uploads[0].opts?.filename, 'a.png');
  assert.equal(adapter.uploads[0].opts?.comment, 'attached');

  const downloaded = await adapter.downloadFile(
    { id: 'F1', name: 'a.png', mimetype: 'image/png', url: 'https://mock.test/F1', raw: null },
    '/tmp/dl',
  );
  assert.equal(downloaded.localPath, '/tmp/dl/F1');
  assert.equal(downloaded.mimetype, 'image/png');
  assert.equal(downloaded.name, 'a.png');
});

test('getPermalink returns deterministic mock URL', async () => {
  const adapter = new MockAdapter();
  const ref = { conduit: 'C1', messageId: 'M7' };
  assert.equal(await adapter.getPermalink(ref), 'https://mock.test/permalink/C1/M7');
});

test('setAdminChannel routes subsequent system notices to the new channel', async () => {
  const adapter = new MockAdapter({ adminChannel: 'C-old' });
  adapter.setAdminChannel('C-new');
  const ref = await adapter.postMessage({ type: 'system-notice' }, { text: 'updated' });
  assert.equal(ref.conduit, 'C-new');
});

test('setAdminChannel null drops subsequent system notices', async () => {
  const adapter = new MockAdapter({ adminChannel: 'C-old' });
  adapter.setAdminChannel(null);
  const ref = await adapter.postMessage({ type: 'system-notice' }, { text: 'cleared' });
  assert.equal(ref.conduit, '');
  assert.equal(adapter.posted.length, 0);
});

test('onMessage handlers fire for simulateMessage and receive context with reply()', async () => {
  const adapter = new MockAdapter();
  let captured: MessageContext | null = null;
  adapter.onMessage(async (ctx) => {
    captured = ctx;
    await ctx.reply({ text: 'echo' });
  });

  await adapter.simulateMessage('C1', 'hello bot', { senderId: 'U42', threadId: 'T1' });

  assert.ok(captured);
  assert.equal(captured!.message.text, 'hello bot');
  assert.equal(captured!.message.senderId, 'U42');
  assert.equal(captured!.message.isBot, false);
  assert.equal(captured!.message.ref.threadId, 'T1');
  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.posted[0].threadId, 'T1');
});

test('onMessage handlers run in registration order for a single simulated event', async () => {
  const adapter = new MockAdapter();
  const calls: string[] = [];
  adapter.onMessage(async () => { calls.push('a'); });
  adapter.onMessage(async () => { calls.push('b'); });
  await adapter.simulateMessage('C1', 'hi');
  assert.deepEqual(calls, ['a', 'b']);
});

test('onMessageEdit handlers fire for simulateMessageEdit with original ref + new text', async () => {
  const adapter = new MockAdapter();
  let captured: MessageEditContext | null = null;
  adapter.onMessageEdit(async (ctx) => { captured = ctx; });
  await adapter.simulateMessageEdit('C1', 'M-7', 'new body');
  assert.equal(captured!.originalRef.conduit, 'C1');
  assert.equal(captured!.originalRef.messageId, 'M-7');
  assert.equal(captured!.newText, 'new body');
});

test('onAction handlers fire for simulateAction with matching actionId only', async () => {
  const adapter = new MockAdapter();
  const captured: ActionContext[] = [];
  adapter.onAction('approve', async (ctx) => { captured.push(ctx); });

  await adapter.simulateAction('approve', 'go', { channelId: 'C9', userId: 'U9', triggerId: 't-1' });
  await adapter.simulateAction('unknown', 'nope');

  assert.equal(captured.length, 1);
  assert.equal(captured[0].actionId, 'approve');
  assert.equal(captured[0].value, 'go');
  assert.equal(captured[0].channelId, 'C9');
  assert.equal(captured[0].userId, 'U9');
  assert.equal(captured[0].triggerId, 't-1');
});

test('onModalSubmit handlers fire for simulateModalSubmit and receive values + ack()', async () => {
  const adapter = new MockAdapter();
  let captured: ModalSubmitContext | null = null;
  let acked = false;
  adapter.onModalSubmit('cb-1', async (ctx) => {
    captured = ctx;
    await ctx.ack();
    acked = true;
  });

  await adapter.simulateModalSubmit('cb-1', { block: { field: { value: 'v1' } } }, {
    privateMetadata: 'meta-1',
    userId: 'U5',
  });

  assert.ok(captured);
  assert.equal(captured!.callbackId, 'cb-1');
  assert.equal(captured!.privateMetadata, 'meta-1');
  assert.equal(captured!.userId, 'U5');
  assert.deepEqual(captured!.values.block.field, { value: 'v1' });
  assert.equal(acked, true);
});

test('simulateAction / simulateModalSubmit are no-ops when no handler registered', async () => {
  const adapter = new MockAdapter();
  await assert.doesNotReject(adapter.simulateAction('not-registered', 'x'));
  await assert.doesNotReject(adapter.simulateModalSubmit('not-registered', {}));
});

test('reset() clears every recorded interaction list', async () => {
  const adapter = new MockAdapter();
  const dest: Destination = { type: 'interactive-reply', conduit: 'C1', sessionId: 's1' };
  const ref = await adapter.postMessage(dest, { text: 'x' });
  await adapter.updateMessage(ref, { text: 'y' });
  await adapter.deleteMessage(ref);
  await adapter.markQueued(ref);
  await adapter.unmarkQueued(ref);
  await adapter.uploadFile(dest, '/tmp/a');
  await adapter.openModal('t', { callbackId: 'cb', title: 'T', fields: [] });

  adapter.reset();
  assert.deepEqual(adapter.posted, []);
  assert.deepEqual(adapter.updated, []);
  assert.deepEqual(adapter.deleted, []);
  assert.deepEqual(adapter.marksQueued, []);
  assert.deepEqual(adapter.marksUnqueued, []);
  assert.deepEqual(adapter.uploads, []);
  assert.deepEqual(adapter.modals, []);
});
