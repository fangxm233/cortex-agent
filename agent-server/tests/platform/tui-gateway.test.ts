// input:  TuiGatewayAdapter + protocol.ts + TuiFrame types
// output: regression tests — handshake, msg.user, session.switch, EADDRINUSE, resume, serial queue, notifications
// pos:    verifies TUI Gateway Adapter M1 implementation
// >>> If I am updated, update the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { TuiGatewayAdapter } from '../../src/platform/adapters/tui/tui-gateway.js';
import { sendProjectReport, sendSystemNotice } from '../../src/platform/adapters/tui/tui-notifications.js';
import { sessionStore } from '../../src/store/session-registry-repo.js';
import { conversationLedger } from '../../src/store/conversation-ledger-repo.js';
import { conversationHistory } from '../../src/store/conversation-history-repo.js';
import { createTuiSessionService } from '../../src/domain/tui-session/index.js';
import { enqueue, conduitQueues } from '../../src/orchestration/conduit-queue.js';
import type { TuiFrame } from '../../src/platform/tui/protocol.js';

/** Inject the real session service + conduit-queue port into a gateway (post-B4 DI). */
function wireTestDeps(adapter: TuiGatewayAdapter): void {
  adapter.setSessionService(createTuiSessionService({ sessionStore, conversationLedger, conversationHistory }));
  adapter.setConduitQueue({ enqueue, remove: (id) => conduitQueues.delete(id) });
}

// ── Helpers ────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.on('close', () => resolve());
  });
}

function sendFrame(ws: WebSocket, frame: TuiFrame): void {
  ws.send(JSON.stringify(frame));
}

function makeFrameCollector(ws: WebSocket) {
  const queue: any[] = [];
  let pendingResolve: ((frame: any) => void) | null = null;

  ws.on('message', (data: Buffer) => {
    let parsed: any;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = null;
      r(parsed);
    } else {
      queue.push(parsed);
    }
  });

  const read = async (timeoutMs = 3000): Promise<any> => {
    if (queue.length > 0) return queue.shift()!;
    return new Promise((resolve, reject) => {
      pendingResolve = resolve;
      setTimeout(() => {
        if (pendingResolve) {
          pendingResolve = null;
          reject(new Error('Frame receive timeout'));
        }
      }, timeoutMs);
    });
  };

  /** Drain any queued frames without reading them (for cleanup between test steps). */
  const drain = (): void => {
    queue.length = 0;
  };

  return { read, drain };
}

async function startEphemeralGateway(): Promise<{
  adapter: TuiGatewayAdapter;
  port: number;
  stop: () => Promise<void>;
}> {
  const adapter = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  await adapter.start();
  wireTestDeps(adapter);
  const wss = (adapter as any)._wss;
  if (!wss) throw new Error('Gateway failed to start (EADDRINUSE on ephemeral port)');
  const addr = wss.address();
  if (!addr || typeof addr !== 'object') throw new Error('Gateway not listening');
  const port = addr.port;
  return {
    adapter,
    port,
    stop: async () => { await adapter.stop(); },
  };
}

async function wsConnect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await waitForOpen(ws);
  return ws;
}

async function handshake(
  ws: WebSocket,
  collector: ReturnType<typeof makeFrameCollector>,
  opts?: { project?: string; resume?: { sessionId: string } | null },
): Promise<{
  conduitId: string;
  sessionId: string;
  sessionName: string;
}> {
  sendFrame(ws, {
    type: 'handshake.hello',
    protocolVersion: 1,
    clientName: 'test',
    clientVersion: '1.0',
    project: opts?.project ?? 'general',
    resume: opts?.resume ?? null,
  });

  const ack: any = await collector.read();
  assert.equal(ack.type, 'handshake.ack');
  assert.equal(ack.protocolVersion, 1);

  // Lazy session creation: a no-resume handshake no longer emits session.switched (no session
  // is minted until the first message). Resume handshakes still announce their session.
  // For tests that need an established session, explicitly create one via session.switch.
  if (opts?.resume) {
    const switched: any = await collector.read();
    assert.equal(switched.type, 'session.switched');
    return { conduitId: ack.conduitId, sessionId: switched.sessionId, sessionName: switched.sessionName };
  }

  sendFrame(ws, { type: 'session.switch', id: 'hs-init', projectId: opts?.project ?? 'general', sessionId: null });
  const switched: any = await collector.read();
  assert.equal(switched.type, 'session.switched');

  return {
    conduitId: ack.conduitId,
    sessionId: switched.sessionId,
    sessionName: switched.sessionName,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

test('handshake → session.attach → msg.user → chat.post → session.switch → close', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  // Step 1: Handshake — fresh session
  const { sessionId: initialSessionId } = await handshake(ws, coll);

  // Step 2: Register message handler
  let capturedText = '';
  adapter.onMessage(async (ctx) => {
    capturedText = ctx.message.text;
    await ctx.reply({ text: 'hello back' });
  });

  // Step 3: Send msg.user
  sendFrame(ws, { type: 'msg.user', id: 'm1', text: 'hello from tui' });

  const chatPost: any = await coll.read();
  assert.equal(chatPost.type, 'chat.post');
  assert.equal(chatPost.content.text, 'hello back');
  assert.equal(chatPost.ref.conduit.length > 0, true);
  assert.equal(chatPost.ref.messageId.length > 0, true);
  assert.equal(capturedText, 'hello from tui');

  // Step 4: Session switch (fresh — echo request id)
  sendFrame(ws, { type: 'session.switch', id: 's1', projectId: 'general', sessionId: null });

  const switched: any = await coll.read();
  assert.equal(switched.type, 'session.switched');
  assert.equal(switched.id, 's1', 'session.switched echoes session.switch request id');
  assert.equal(switched.isFresh, true);
  assert.notEqual(switched.sessionId, initialSessionId);

  // Step 5: Close
  ws.close();
  await waitForClose(ws);
});

test('lazy session: no-resume handshake emits NO session.switched (no session minted on open)', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  sendFrame(ws, {
    type: 'handshake.hello', protocolVersion: 1, clientName: 'test', clientVersion: '1.0',
    project: 'general', resume: null,
  });

  const ack: any = await coll.read();
  assert.equal(ack.type, 'handshake.ack');

  // No session.switched should follow — opening the TUI must not mint a session.
  const next = await coll.read(400).catch(() => null);
  assert.equal(next, null, 'no session.switched (no session created at handshake)');

  // The connection exists but carries no active session yet.
  const conn = Array.from(adapter.connections.values())[0];
  assert.equal(conn.activeSessionId, null, 'conduit is session-less until the first message');
});

test('lazy session: the first msg.user mints + announces the session, then replies', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  sendFrame(ws, {
    type: 'handshake.hello', protocolVersion: 1, clientName: 'test', clientVersion: '1.0',
    project: 'general', resume: null,
  });
  const ack: any = await coll.read();
  assert.equal(ack.type, 'handshake.ack');

  adapter.onMessage(async (ctx) => { await ctx.reply({ text: 'reply' }); });

  sendFrame(ws, { type: 'msg.user', id: 'm1', text: 'first message' });

  // First the lazily-created session is announced...
  const switched: any = await coll.read();
  assert.equal(switched.type, 'session.switched');
  assert.equal(switched.isFresh, true);
  assert.ok(switched.sessionId.length > 0);

  // ...then the agent reply.
  const post: any = await coll.read();
  assert.equal(post.type, 'chat.post');
  assert.equal(post.content.text, 'reply');
});

test('handshake protocol version mismatch causes error + close', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  sendFrame(ws, {
    type: 'handshake.hello',
    protocolVersion: 999,
    clientName: 'test',
    clientVersion: '1.0',
  });

  const error: any = await coll.read();
  assert.equal(error.type, 'error');
  assert.equal(error.code, 4000);
  assert.ok(error.message.includes('Protocol version mismatch'));

  await waitForClose(ws);
});

test('handshake timeout closes connection', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  t.onTestFinished(() => ws.close());

  // Don't send handshake — should be closed by 5s timeout
  await waitForClose(ws);
});

test('unknown frame type returns error 4002 without close', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  await handshake(ws, coll);

  // Send unknown frame type — should get 4002 (not 4001)
  sendFrame(ws, { type: 'unknown.type', id: 'x1' } as any);

  const error: any = await coll.read();
  assert.equal(error.type, 'error');
  assert.equal(error.code, 4002);

  // Connection should still be open
  assert.equal(ws.readyState, WebSocket.OPEN);
});

test('message edit dispatches to edit handler', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  await handshake(ws, coll);

  let capturedEdit: any = null;
  adapter.onMessageEdit(async (ctx) => {
    capturedEdit = { ref: ctx.originalRef, newText: ctx.newText };
  });

  sendFrame(ws, {
    type: 'msg.edit',
    id: 'e1',
    ref: { conduit: 'c1', messageId: 'm1' },
    newText: 'edited text',
  });

  await delay(100);
  assert.ok(capturedEdit);
  assert.equal(capturedEdit.newText, 'edited text');
});

test('action click dispatches to registered handler', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  await handshake(ws, coll);

  let capturedAction: any = null;
  adapter.onAction('test_action', async (ctx) => {
    capturedAction = { actionId: ctx.actionId, value: ctx.value, userId: ctx.userId };
  });

  sendFrame(ws, {
    type: 'action.click',
    id: 'a1',
    actionId: 'test_action',
    value: 'click_val',
    triggerId: 'trig-1',
    userId: 'user-1',
  });

  await delay(100);
  assert.ok(capturedAction);
  assert.equal(capturedAction.actionId, 'test_action');
  assert.equal(capturedAction.value, 'click_val');
});

test('modal submit → ack roundtrip', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  await handshake(ws, coll);

  let acked = false;
  adapter.onModalSubmit('test_modal', async (ctx) => {
    await ctx.ack();
    acked = true;
  });

  sendFrame(ws, {
    type: 'modal.submit',
    id: 'ms1',
    callbackId: 'test_modal',
    privateMetadata: '{}',
    values: {},
    userId: 'user-1',
  });

  const ack: any = await coll.read();
  assert.equal(ack.type, 'modal.ack');
  assert.equal(ack.id, 'ms1');
  assert.equal(acked, true);
});

test('modal submit with errors sends error response', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  await handshake(ws, coll);

  adapter.onModalSubmit('validate_modal', async (ctx) => {
    await ctx.ack({ errors: { field1: 'Required' } });
  });

  sendFrame(ws, {
    type: 'modal.submit',
    id: 'ms2',
    callbackId: 'validate_modal',
    privateMetadata: '{}',
    values: {},
    userId: 'user-1',
  });

  const ack: any = await coll.read();
  assert.equal(ack.type, 'modal.ack');
  assert.deepEqual(ack.errors, { field1: 'Required' });
});

test('ping triggers pong', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  await handshake(ws, coll);

  sendFrame(ws, { type: 'ping', ts: Date.now() });

  const pong: any = await coll.read();
  assert.equal(pong.type, 'pong');
  assert.ok(typeof pong.ts === 'number');
});

// ── EADDRINUSE ─────────────────────────────────────────────────────────

test('EADDRINUSE soft-failure — second adapter becomes noop', async (t) => {
  const adapter1 = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  await adapter1.start();
  t.onTestFinished(() => adapter1.stop());

  const actualPort = (adapter1 as any)._wss.address().port;

  const adapter2 = new TuiGatewayAdapter({ port: actualPort, host: '127.0.0.1' });
  await adapter2.start();
  t.onTestFinished(() => adapter2.stop());

  assert.equal(adapter2.noopOutbound, true);
});

// ── Per-conduit serial queue ──────────────────────────────────────────

test('per-conduit serial queue — same conduit serialised, different conduits parallel', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const order: string[] = [];
  const handlerDelay = 200;

  adapter.onMessage(async (ctx) => {
    order.push(`start-${ctx.message.text}`);
    await delay(handlerDelay);
    await ctx.reply({ text: `reply-${ctx.message.text}` });
    order.push(`end-${ctx.message.text}`);
  });

  // Connect two clients
  const ws1 = await wsConnect(port);
  const coll1 = makeFrameCollector(ws1);
  t.onTestFinished(() => ws1.close());

  const ws2 = await wsConnect(port);
  const coll2 = makeFrameCollector(ws2);
  t.onTestFinished(() => ws2.close());

  await handshake(ws1, coll1);
  await handshake(ws2, coll2);

  // Send two msgs on same conduit (ws1) — should be serialised
  sendFrame(ws1, { type: 'msg.user', id: 's1a', text: 'a' });
  sendFrame(ws1, { type: 'msg.user', id: 's1b', text: 'b' });

  // Wait for both replies
  const r1: any = await coll1.read();
  assert.equal(r1.type, 'chat.post');
  assert.equal(r1.content.text, 'reply-a');

  const r2: any = await coll1.read();
  assert.equal(r2.type, 'chat.post');
  assert.equal(r2.content.text, 'reply-b');

  // Verify serialisation: handler-b did not start before handler-a ended
  const aIdx = order.indexOf('start-a');
  const aEndIdx = order.indexOf('end-a');
  const bIdx = order.indexOf('start-b');
  assert.ok(aIdx >= 0, 'handler-a started');
  assert.ok(aEndIdx >= 0, 'handler-a ended');
  assert.ok(bIdx >= 0, 'handler-b started');
  assert.ok(aEndIdx < bIdx, 'handler-b started after handler-a ended (serialised)');
});

test('different conduits run message handlers in parallel', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const startOrder: string[] = [];

  adapter.onMessage(async (ctx) => {
    startOrder.push(ctx.message.text);
    await delay(200);
    await ctx.reply({ text: `done-${ctx.message.text}` });
  });

  const ws1 = await wsConnect(port);
  const coll1 = makeFrameCollector(ws1);
  t.onTestFinished(() => ws1.close());

  const ws2 = await wsConnect(port);
  const coll2 = makeFrameCollector(ws2);
  t.onTestFinished(() => ws2.close());

  await handshake(ws1, coll1);
  await handshake(ws2, coll2);

  sendFrame(ws1, { type: 'msg.user', id: 'p1', text: 'x' });
  sendFrame(ws2, { type: 'msg.user', id: 'p2', text: 'y' });

  // Both should have started before either handler delay completes
  await delay(50);

  assert.equal(startOrder.includes('x'), true, 'conduit-x handler started');
  assert.equal(startOrder.includes('y'), true, 'conduit-y handler started');
});

// ── UI side-channel ───────────────────────────────────────────────────

test('ui.query without uiService returns error result', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  await handshake(ws, coll);

  sendFrame(ws, { type: 'ui.query', id: 'q1', scope: 'test', params: {} });

  const result: any = await coll.read();
  assert.equal(result.type, 'ui.queryResult');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ui-service-unavailable');
});

test('ui.mutate without uiService returns error result', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  await handshake(ws, coll);

  sendFrame(ws, { type: 'ui.mutate', id: 'm1', op: 'test', args: {} });

  const result: any = await coll.read();
  assert.equal(result.type, 'ui.mutateResult');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ui-service-unavailable');
});

// ── UI query with UiService ────────────────────────────────────────

test('ui.query with UiService returns real data', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const mockUiService = {
    query: async (_scope: string, _params: any) => ({ ok: true, data: [{ id: '1', name: 'test-project' }] }),
    mutate: async () => ({ ok: true }),
    subscribe: () => { throw new Error('not implemented'); },
  };
  (adapter as any).setUiService(mockUiService);

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  await handshake(ws, coll);

  sendFrame(ws, { type: 'ui.query', id: 'q1', scope: 'projects.list', params: {} });

  const result: any = await coll.read();
  assert.equal(result.type, 'ui.queryResult');
  assert.equal(result.id, 'q1');
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.data));
  assert.equal(result.data[0].id, '1');
  assert.equal(result.data[0].name, 'test-project');
});

test('ui.query with UiService returning error forwards error code', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const mockUiService = {
    query: async () => ({ ok: false, code: 'invalid-args', message: 'bad scope' }),
    mutate: async () => ({ ok: true }),
    subscribe: () => { throw new Error('not implemented'); },
  };
  (adapter as any).setUiService(mockUiService);

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  await handshake(ws, coll);

  sendFrame(ws, { type: 'ui.query', id: 'q2', scope: 'invalid.scope', params: {} });

  const result: any = await coll.read();
  assert.equal(result.type, 'ui.queryResult');
  assert.equal(result.id, 'q2');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid-args');
});

test('ui.query with UiService that throws returns internal error', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const mockUiService = {
    query: async () => { throw new Error('db connection failed'); },
    mutate: async () => ({ ok: true }),
    subscribe: () => { throw new Error('not implemented'); },
  };
  (adapter as any).setUiService(mockUiService);

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  await handshake(ws, coll);

  sendFrame(ws, { type: 'ui.query', id: 'q3', scope: 'projects.list', params: {} });

  const result: any = await coll.read();
  assert.equal(result.type, 'ui.queryResult');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'internal');
});

// ── UI subscribe with UiService ────────────────────────────────────

test('ui.subscribe with UiService forwards events to connection', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const events: Array<{ type: string; ts: string; payload: unknown }> = [
    { type: 'thread.created', ts: '2024-01-01T00:00:00Z', payload: { threadId: 't1' } },
    { type: 'thread.completed', ts: '2024-01-01T01:00:00Z', payload: { threadId: 't1' } },
  ];
  let subscriptionClosed = false;

  const mockSubscription = {
    close: () => { subscriptionClosed = true; },
    [Symbol.asyncIterator]: () => {
      let idx = 0;
      return {
        next: async (): Promise<IteratorResult<any>> => {
          if (idx < events.length) return { value: events[idx++], done: false };
          // Hang — subscription stays alive
          return new Promise(() => {});
        },
      };
    },
  };

  const mockUiService = {
    query: async () => ({ ok: true, data: [] }),
    mutate: async () => ({ ok: true }),
    subscribe: () => mockSubscription,
  };
  (adapter as any).setUiService(mockUiService);

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  await handshake(ws, coll);

  sendFrame(ws, {
    type: 'ui.subscribe',
    id: 'sub1',
    filter: { events: ['thread.created', 'thread.completed'] },
  });

  // Read first event
  const ev1: any = await coll.read();
  assert.equal(ev1.type, 'ui.event');
  assert.equal(ev1.id, 'sub1');
  assert.equal(ev1.event.type, 'thread.created');

  // Read second event
  const ev2: any = await coll.read();
  assert.equal(ev2.type, 'ui.event');
  assert.equal(ev2.id, 'sub1');
  assert.equal(ev2.event.type, 'thread.completed');
});

test('ui.unsubscribe closes subscription', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  let subscriptionClosed = false;
  const mockSubscription = {
    close: () => { subscriptionClosed = true; },
    [Symbol.asyncIterator]: () => ({
      next: async () => new Promise(() => {}), // hangs
    }),
  };

  const mockUiService = {
    query: async () => ({ ok: true, data: [] }),
    mutate: async () => ({ ok: true }),
    subscribe: () => mockSubscription,
  };
  (adapter as any).setUiService(mockUiService);

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  await handshake(ws, coll);

  sendFrame(ws, {
    type: 'ui.subscribe',
    id: 'sub2',
    filter: { events: ['thread.created'] },
  });

  await delay(50);

  sendFrame(ws, { type: 'ui.unsubscribe', id: 'sub2' });

  await delay(50);
  assert.equal(subscriptionClosed, true);
});

test('ui.subscribe without UiService returns error', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  await handshake(ws, coll);

  sendFrame(ws, {
    type: 'ui.subscribe',
    id: 'sub3',
    filter: { events: ['thread.created'] },
  });

  const result: any = await coll.read();
  assert.equal(result.type, 'error');
  assert.equal(result.code, 4100);
});

// ── Notification routing (unit-level, no WS) ─────────────────────────

test('sendProjectReport routes per activeSession equality', async (t) => {
  const adapter = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  await adapter.start();
  wireTestDeps(adapter);
  const actualPort = (adapter as any)._wss.address().port;
  t.onTestFinished(() => adapter.stop());

  // Two WS connections → two conduits with distinct sessions
  const ws1 = await wsConnect(actualPort);
  const coll1 = makeFrameCollector(ws1);
  t.onTestFinished(() => ws1.close());

  const ws2 = await wsConnect(actualPort);
  const coll2 = makeFrameCollector(ws2);
  t.onTestFinished(() => ws2.close());

  await handshake(ws1, coll1, { project: 'test-proj' });
  await handshake(ws2, coll2, { project: 'test-proj' });

  // Drain handshake leftover frames
  coll1.drain();
  coll2.drain();

  const conns = Array.from(adapter.connections.values());
  assert.equal(conns.length, 2);
  assert.notEqual(conns[0].activeSessionId, conns[1].activeSessionId);

  // Use conns[0].activeSessionId as source
  const sourceSessionId = conns[0].activeSessionId!;
  sendProjectReport(conns, 'test-proj', sourceSessionId, 'Report', 'Body');

  // Collect frames from both WS connections
  const ws1Frame = await coll1.read(2000).catch(() => null);
  const ws2Frame = await coll2.read(2000).catch(() => null);

  // Exactly one chat.post and one notification
  const received = [ws1Frame, ws2Frame].filter(Boolean);
  assert.equal(received.length, 2, 'two frames received');

  const postFrames = received.filter((f: any) => f.type === 'chat.post');
  const notifFrames = received.filter((f: any) => f.type === 'notification');
  assert.equal(postFrames.length, 1, 'one chat.post');
  assert.equal(notifFrames.length, 1, 'one notification');
  assert.equal(notifFrames[0].kind, 'project-report');
});

test('sendProjectReport delivers cross-project notification frames', async (t) => {
  const adapter = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  await adapter.start();
  wireTestDeps(adapter);
  const actualPort = (adapter as any)._wss.address().port;
  t.onTestFinished(() => adapter.stop());

  // Connection in project-a
  const ws1 = await wsConnect(actualPort);
  const coll1 = makeFrameCollector(ws1);
  t.onTestFinished(() => ws1.close());
  await handshake(ws1, coll1, { project: 'project-a' });

  // Connection in project-b
  const ws2 = await wsConnect(actualPort);
  const coll2 = makeFrameCollector(ws2);
  t.onTestFinished(() => ws2.close());
  await handshake(ws2, coll2, { project: 'project-b' });

  // Drain handshake leftover frames
  coll1.drain();
  coll2.drain();

  const conns = Array.from(adapter.connections.values());
  assert.equal(conns.length, 2);
  assert.notEqual(conns[0].activeProjectId, conns[1].activeProjectId);

  // Send project-report for project-a
  const sourceSessionId = conns[0].activeSessionId!;
  sendProjectReport(conns, 'project-a', sourceSessionId, 'Report', 'Body');

  // Collect frames from both WS connections
  const ws1Frame = await coll1.read(2000);
  const ws2Frame = await coll2.read(2000);

  // ws1 (project-a, matching session) gets chat.post
  assert.equal(ws1Frame.type, 'chat.post');
  assert.equal(ws1Frame.content.text, 'Report\nBody');

  // ws2 (project-b, cross-project) gets notification
  assert.equal(ws2Frame.type, 'notification');
  assert.equal(ws2Frame.kind, 'project-report');
  assert.equal(ws2Frame.projectId, 'project-a');
  assert.equal(ws2Frame.title, 'Report');
  assert.equal(ws2Frame.body, 'Body');
});

test('sendSystemNotice fans out to all connections', async (t) => {
  const adapter = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  await adapter.start();
  wireTestDeps(adapter);
  const actualPort = (adapter as any)._wss.address().port;
  t.onTestFinished(() => adapter.stop());

  const ws1 = await wsConnect(actualPort);
  const coll1 = makeFrameCollector(ws1);
  t.onTestFinished(() => ws1.close());

  const ws2 = await wsConnect(actualPort);
  const coll2 = makeFrameCollector(ws2);
  t.onTestFinished(() => ws2.close());

  await handshake(ws1, coll1);
  await handshake(ws2, coll2);

  // Drain leftover frames
  coll1.drain();
  coll2.drain();

  const conns = Array.from(adapter.connections.values());

  sendSystemNotice(conns, 'System Alert', 'Something happened');

  // Both should receive a notification frame
  const ws1Frame: any = await coll1.read(2000);
  const ws2Frame: any = await coll2.read(2000);

  assert.equal(ws1Frame.type, 'notification');
  assert.equal(ws1Frame.kind, 'system-notice');
  assert.equal(ws2Frame.type, 'notification');
  assert.equal(ws2Frame.kind, 'system-notice');
});

// ── uploadFile sends path-offer notification ──────────────────────────

test('uploadFile sends notification with absolute path', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  const { sessionId } = await handshake(ws, coll);
  coll.drain();

  await adapter.uploadFile(
    { type: 'interactive-reply', conduit: '', sessionId },
    '/tmp/test-file.txt',
  );

  const frame: any = await coll.read();
  assert.equal(frame.type, 'notification');
  assert.equal(frame.kind, 'system-notice');
  assert.ok(frame.body.includes('/tmp/test-file.txt'));
});

// ── Conduit state tracking ────────────────────────────────────────────

test('conduits are tracked and cleaned up on close', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  assert.equal(adapter.connections.size, 0);

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);

  await handshake(ws, coll);

  assert.equal(adapter.connections.size, 1);

  ws.close();
  await waitForClose(ws);

  // Give async cleanup time to run
  await delay(100);

  assert.equal(adapter.connections.size, 0);
});

// ── Resolve target connections by destination type ────────────────────

test('postMessage sends to connection matching sessionId', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  const { sessionId } = await handshake(ws, coll);
  coll.drain();

  const ref = await adapter.postMessage(
    { type: 'interactive-reply', conduit: '', sessionId },
    { text: 'outbound test' },
  );

  const frame: any = await coll.read();
  assert.equal(frame.type, 'chat.post');
  assert.equal(frame.content.text, 'outbound test');
  assert.equal(frame.ref.conduit.length > 0, true);
});

test('postMessage on noop adapter returns empty ref', async () => {
  const adapter = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  // Simulate EADDRINUSE by directly setting noop
  (adapter as any)._noopOutbound = true;

  const ref = await adapter.postMessage(
    { type: 'interactive-reply', conduit: 'c1', sessionId: '' },
    { text: 'noop' },
  );

  assert.equal(ref.conduit, '');
  assert.equal(ref.messageId, '');
});

test('postMessage sends chat.post to matching project and notification to cross-project connections', async (t) => {
  const adapter = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  await adapter.start();
  wireTestDeps(adapter);
  const actualPort = (adapter as any)._wss.address().port;
  t.onTestFinished(() => adapter.stop());

  // Connection in project-a
  const ws1 = await wsConnect(actualPort);
  const coll1 = makeFrameCollector(ws1);
  t.onTestFinished(() => ws1.close());
  await handshake(ws1, coll1, { project: 'project-a' });

  // Connection in project-b
  const ws2 = await wsConnect(actualPort);
  const coll2 = makeFrameCollector(ws2);
  t.onTestFinished(() => ws2.close());
  await handshake(ws2, coll2, { project: 'project-b' });

  // Drain handshake leftover frames
  coll1.drain();
  coll2.drain();

  // Post project-report for project-a
  const ref = await adapter.postMessage(
    { type: 'project-report', projectId: 'project-a', trigger: 'test', sessionId: '' },
    { text: 'report text' },
  );

  // ws1 (project-a matching) gets chat.post with a valid ref
  const ws1Frame = await coll1.read(2000);
  assert.equal(ws1Frame.type, 'chat.post');
  assert.equal(ws1Frame.content.text, 'report text');
  assert.equal(ws1Frame.ref.conduit.length > 0, true);

  // ws2 (project-b cross-project) gets notification
  const ws2Frame = await coll2.read(2000);
  assert.equal(ws2Frame.type, 'notification');
  assert.equal(ws2Frame.kind, 'project-report');
  assert.equal(ws2Frame.projectId, 'project-a');
  assert.equal(ws2Frame.body, 'report text');

  // Ref should be from the matching connection
  assert.equal(ref.conduit, ws1Frame.ref.conduit);
  assert.equal(ref.messageId, ws1Frame.ref.messageId);
});

// ── OpenOutputStream ──────────────────────────────────────────────────

test('openOutputStream creates TuiOutputStream for matching connection', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  const { sessionId } = await handshake(ws, coll);
  coll.drain();

  const stream = adapter.openOutputStream(
    { type: 'interactive-reply', conduit: '', sessionId },
  );

  stream.emitText('stream test');
  await stream.flush();

  // Should receive stream.text frame
  const frame: any = await coll.read();
  assert.equal(frame.type, 'stream.text');
  assert.equal(frame.text, 'stream test');
});

test('openOutputStream on noop adapter returns noop stream', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const stream = adapter.openOutputStream(
    { type: 'system-notice' },
  );

  // Noop stream should not throw
  stream.emitText('test');
  stream.openMutable('test');
  await stream.postInteractive('test');
  await stream.flush();
  assert.equal(stream.getRefs().length, 0);
  assert.equal(stream.getParentRef(), null);
});

// ── Resume / switch characterization (B0) ────────────────────────────

test('handshake resume with unknown sessionId emits error 4003 then fresh session', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  // Send handshake.hello with a non-existent sessionId
  const unknownSessionId = crypto.randomUUID();
  sendFrame(ws, {
    type: 'handshake.hello',
    protocolVersion: 1,
    clientName: 'test',
    clientVersion: '1.0',
    project: 'general',
    resume: { sessionId: unknownSessionId },
  });

  // First: handshake.ack (always sent before resume logic)
  const ack: any = await coll.read();
  assert.equal(ack.type, 'handshake.ack');

  // Then: error frame with code 4003
  const error: any = await coll.read();
  assert.equal(error.type, 'error');
  assert.equal(error.code, 4003);
  assert.ok(error.message.includes('not found'));

  // Finally: session.switched with isFresh: true (fallback session created)
  const switched: any = await coll.read();
  assert.equal(switched.type, 'session.switched');
  assert.equal(switched.isFresh, true);
  assert.notEqual(switched.sessionId, unknownSessionId);
});

test('session.switch with unknown sessionId creates fresh session silently', async (t) => {
  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  // Normal handshake first
  const { sessionId: initialSessionId } = await handshake(ws, coll);

  // Drain any leftover frames
  coll.drain();

  // Send session.switch with a non-existent sessionId
  const unknownSessionId = crypto.randomUUID();
  sendFrame(ws, {
    type: 'session.switch',
    id: 's1',
    projectId: 'general',
    sessionId: unknownSessionId,
  });

  // Should get session.switched directly (no error frame)
  const switched: any = await coll.read();
  assert.equal(switched.type, 'session.switched');
  assert.equal(switched.id, 's1');
  assert.equal(switched.isFresh, true);
  assert.notEqual(switched.sessionId, unknownSessionId);
  assert.notEqual(switched.sessionId, initialSessionId);

  // Verify no error frame follows
  const maybeError = await coll.read(500).catch(() => null);
  assert.equal(maybeError, null, 'no error frame emitted after switch-not-found');
});

test('handshake resume with known sessionId attaches to existing session', async (t) => {
  const knownSessionId = crypto.randomUUID();
  const sessionName = 'cortex-test-session-b0';

  // Pre-seed session in sessionStore (against test's CORTEX_HOME)
  await sessionStore.registerSession(sessionName, {
    sessionId: knownSessionId,
    channel: 'b0-test-channel',
    backend: 'tui',
    kind: 'local',
    projectId: 'general',
  });

  // Pre-seed conversation ledger
  await conversationLedger.initConversation('b0-test-channel', {
    sessionId: knownSessionId,
    sessionName,
    backend: 'tui',
  });

  const { adapter, port, stop } = await startEphemeralGateway();
  t.onTestFinished(() => stop());

  const ws = await wsConnect(port);
  const coll = makeFrameCollector(ws);
  t.onTestFinished(() => ws.close());

  // Send handshake.hello with resume.sessionId pointing to known session
  sendFrame(ws, {
    type: 'handshake.hello',
    protocolVersion: 1,
    clientName: 'test',
    clientVersion: '1.0',
    project: 'general',
    resume: { sessionId: knownSessionId },
  });

  // Read handshake.ack
  const ack: any = await coll.read();
  assert.equal(ack.type, 'handshake.ack');

  // Read session.switched — isFresh must be false
  const switched: any = await coll.read();
  assert.equal(switched.type, 'session.switched');
  assert.equal(switched.sessionId, knownSessionId);
  assert.equal(switched.isFresh, false);
});
