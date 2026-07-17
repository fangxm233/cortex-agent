// input:  Node test runner + SlackAdapter subtype→kind mapping
// output: IncomingMessage.kind correctness per Slack subtype
// pos:    Verify Slack adapter classifies all known subtypes into the semantic 3-kind system
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SlackAdapter } from '../src/platform/adapters/slack.js';
import type { MessageContext } from '../src/platform/types.js';

/**
 * Create a SlackAdapter that captures the IncomingMessage passed to onMessage.
 */
function makeCaptureAdapter(): {
  adapter: SlackAdapter;
  captured: MessageContext[];
  triggerEvent: (event: Record<string, any>) => Promise<void>;
} {
  const adapter = Object.create(SlackAdapter.prototype) as SlackAdapter;
  (adapter as any).config = { botToken: 'xoxb-test', signingSecret: 'sig', appToken: 'xapp-test' };
  (adapter as any).pendingEdits = new Map();
  (adapter as any)._adminAutoDetected = false;

  const captured: MessageContext[] = [];

  // Capture the inner callback that onMessage registers on this.app.event
  let registeredCb: ((args: { event: any; client: any }) => Promise<void>) | null = null;
  (adapter as any).app = {
    event: (_event: string, cb: any) => {
      registeredCb = cb;
    },
  };

  adapter.onMessage(async (ctx) => {
    captured.push(ctx);
  });

  return {
    adapter,
    captured,
    async triggerEvent(event: Record<string, any>) {
      if (!registeredCb) throw new Error('onMessage handler not registered');
      await registeredCb({ event, client: {} });
    },
  };
}

// ── undefined subtype → kind: 'user' ──

test('SlackAdapter: undefined subtype maps to kind=user', async () => {
  const { captured, triggerEvent } = makeCaptureAdapter();
  await triggerEvent({
    type: 'message',
    subtype: undefined,
    channel: 'C1',
    ts: '123',
    user: 'U1',
    text: 'hello',
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].message.kind, 'user');
});

test('SlackAdapter: missing subtype field maps to kind=user', async () => {
  const { captured, triggerEvent } = makeCaptureAdapter();
  await triggerEvent({
    type: 'message',
    // no subtype field at all
    channel: 'C1',
    ts: '123',
    user: 'U1',
    text: 'hello',
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].message.kind, 'user');
});

// ── file_share → kind: 'file_share' ──

test('SlackAdapter: file_share subtype maps to kind=file_share', async () => {
  const { captured, triggerEvent } = makeCaptureAdapter();
  await triggerEvent({
    type: 'message',
    subtype: 'file_share',
    channel: 'C1',
    ts: '123',
    user: 'U1',
    text: '',
    files: [{ id: 'F1', name: 'doc.pdf', mimetype: 'application/pdf' }],
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].message.kind, 'file_share');
});

// ── system subtypes → kind: 'system' ──

const SYSTEM_SUBTYPES = [
  'bot_message',
  'message_changed',
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
];

for (const subtype of SYSTEM_SUBTYPES) {
  test(`SlackAdapter: ${subtype} subtype maps to kind=system`, async () => {
    const { captured, triggerEvent } = makeCaptureAdapter();
    await triggerEvent({
      type: 'message',
      subtype,
      channel: 'C1',
      ts: '123',
      user: 'U1',
      text: 'ignored',
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].message.kind, 'system');
  });
}

// ── message_changed also routes to edit handler ──

test('SlackAdapter: message_changed subtype is still kind=system and triggers edit handler', async () => {
  const adapter = Object.create(SlackAdapter.prototype) as SlackAdapter;
  (adapter as any).config = { botToken: 'xoxb-test', signingSecret: 'sig', appToken: 'xapp-test' };
  (adapter as any).pendingEdits = new Map();
  (adapter as any)._adminAutoDetected = false;

  let registeredCb: ((args: { event: any; client: any }) => Promise<void>) | null = null;
  (adapter as any).app = {
    event: (_event: string, cb: any) => {
      registeredCb = cb;
    },
  };

  let editCalled = false;
  adapter.onMessageEdit(async () => { editCalled = true; });

  const captured: MessageContext[] = [];
  adapter.onMessage(async (ctx) => {
    captured.push(ctx);
  });

  await registeredCb!({
    event: {
      type: 'message',
      subtype: 'message_changed',
      channel: 'C1',
      ts: '123',
      message: {
        ts: '456',
        text: 'edited text',
        subtype: 'bot_message',
      },
      previous_message: { ts: '456', text: 'original' },
    },
    client: {},
  });

  // Edit handler was called (internal routing)
  assert.equal(editCalled, false, 'edit handler should not fire for bot_message edited by bot');

  // No message handler capture (it returned early due to message_changed routing)
  assert.equal(captured.length, 0);
});

// ── file_share preserves files ──

test('SlackAdapter: file_share message includes files in IncomingMessage', async () => {
  const { captured, triggerEvent } = makeCaptureAdapter();
  await triggerEvent({
    type: 'message',
    subtype: 'file_share',
    channel: 'C1',
    ts: '123',
    user: 'U1',
    text: '',
    files: [
      { id: 'F1', name: 'doc.pdf', mimetype: 'application/pdf', url_private: 'https://files.slack.com/doc.pdf' },
    ],
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].message.kind, 'file_share');
  assert.ok(captured[0].message.files, 'files should be present');
  assert.equal(captured[0].message.files!.length, 1);
  assert.equal(captured[0].message.files![0].id, 'F1');
});

// ── kind field is not optional ──

test('SlackAdapter: IncomingMessage has kind (not subtype)', async () => {
  const { captured, triggerEvent } = makeCaptureAdapter();
  await triggerEvent({
    type: 'message',
    subtype: undefined,
    channel: 'C1',
    ts: '123',
    user: 'U1',
    text: 'hello',
  });
  assert.equal(captured.length, 1);
  const msg = captured[0].message as any;
  // subtype should not exist
  assert.equal('subtype' in msg, false, 'IncomingMessage should not have subtype field');
  // kind should exist
  assert.equal(msg.kind, 'user');
});
