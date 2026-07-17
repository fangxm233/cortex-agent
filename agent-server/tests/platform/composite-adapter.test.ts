// input:  CompositeAdapter + FanOutOutputStream + extractTuiAdapter + MockAdapter + TuiGatewayAdapter
// output: Composite adapter unit tests
// pos:    Verify fan-out routing, interactive-reply isolation, capabilities merging, extractTuiAdapter, FanOutOutputStream

import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { MockAdapter } from '../../src/platform/testing.js';
import { CompositeAdapter, extractTuiAdapter, FanOutOutputStream } from '../../src/platform/adapters/composite-adapter.js';
import { TuiGatewayAdapter, TuiConnection } from '../../src/platform/adapters/tui/index.js';
import { tuiConduitStates, setConduitState, deleteConduitState } from '../../src/platform/adapters/tui/tui-conduit-state.js';
import type { OutputStream, MutableRegion } from '../../src/platform/output-stream.js';
import type { MessageRef, RichBlock, ActionElement } from '../../src/platform/types.js';

// ── Helpers ───────────────────────────────────────────────────────

function makeMockWs(): WebSocket {
  return { send: () => {}, close: () => {}, on: () => {} } as unknown as WebSocket;
}

/** RecordingOutputStream: records all operations in a `segments` array for test assertions. */
class RecordingOutputStream implements OutputStream {
  readonly segments: string[] = [];
  readonly refs: MessageRef[] = [];
  parentRef: MessageRef | null = null;

  emitText(text: string): void {
    this.segments.push(`emit:${text}`);
  }

  openMutable(text: string): MutableRegion {
    this.segments.push(`mutable:${text}`);
    return { update: (t) => { this.segments.push(`update:${t}`); } };
  }

  async postInteractive(text: string, _opts?: { richBlocks?: RichBlock[]; actions?: ActionElement[] }): Promise<MessageRef | null> {
    this.segments.push(`interactive:${text}`);
    const ref: MessageRef = { conduit: 'test', messageId: String(this.refs.length + 1) };
    this.refs.push(ref);
    if (!this.parentRef) this.parentRef = ref;
    return ref;
  }

  async flush(): Promise<void> {
    this.segments.push('flush');
  }

  getRefs(): MessageRef[] {
    return [...this.refs];
  }

  getParentRef(): MessageRef | null {
    return this.parentRef;
  }
}

// Clean up global conduit states after each test
afterEach(() => {
  tuiConduitStates.clear();
});

// ── Test: Fan-out project-report ──────────────────────────────────

test('CompositeAdapter: project-report fan-out to primary and gateway', async () => {
  const primary = new MockAdapter({ adminChannel: 'C-admin' });
  const gateway = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  const composite = new CompositeAdapter([primary, gateway]);

  // Set up TUI connection with correct project binding
  const sentFrames: any[] = [];
  const mockWs = {
    send: (data: string) => { sentFrames.push(JSON.parse(data)); },
    close: () => {},
    on: () => {},
  } as unknown as WebSocket;
  const conn = new TuiConnection('tui-test-1', mockWs, 'test-project');
  gateway.connections.set('tui-test-1', conn);
  // Set conduit state so gateway.getProjectConduits() includes this project
  setConduitState('tui-test-1', { sessionId: null, projectId: 'test-project', backend: 'tui' });

  // Bind primary conduit
  await primary.bindProjectConduit('test-project', 'C12345');

  // Post project-report
  const ref = await composite.postMessage(
    { type: 'project-report', projectId: 'test-project', trigger: 'test', sessionId: '' },
    { text: 'hello from both' },
  );

  // Both adapters should have received the message
  assert.equal(primary.posted.length, 1);
  assert.equal(primary.posted[0].content.text, 'hello from both');
  assert.equal(primary.posted[0].destination.type, 'project-report');
  assert.equal(sentFrames.length, 1);
  assert.equal(sentFrames[0].type, 'chat.post');
  assert.equal(sentFrames[0].content.text, 'hello from both');

  // First ref should be from primary (MockAdapter returns projectId as conduit for project-report)
  assert.ok(ref.conduit !== '');
  assert.ok(ref.messageId !== '');
});

test('CompositeAdapter: project-report fans out to gateway with cross-project TUI connection', async () => {
  const primary = new MockAdapter({ adminChannel: 'C-admin' });
  const gateway = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  const composite = new CompositeAdapter([primary, gateway]);

  // TUI connection in project-a only
  const sentFrames: any[] = [];
  const mockWs = {
    send: (data: string) => { sentFrames.push(JSON.parse(data)); },
    close: () => {},
    on: () => {},
  } as unknown as WebSocket;
  const conn = new TuiConnection('tui-cross-1', mockWs, 'project-a');
  gateway.connections.set('tui-cross-1', conn);
  setConduitState('tui-cross-1', { sessionId: null, projectId: 'project-a', backend: 'tui' });

  // Primary conduit in project-b
  await primary.bindProjectConduit('project-b', 'C12345');

  // Post project-report for project-b (no direct TUI conduit for project-b)
  const ref = await composite.postMessage(
    { type: 'project-report', projectId: 'project-b', trigger: 'test', sessionId: '' },
    { text: 'cross-project report' },
  );

  // Primary should have received the message
  assert.equal(primary.posted.length, 1);
  assert.equal(primary.posted[0].content.text, 'cross-project report');
  assert.equal(primary.posted[0].destination.type, 'project-report');

  // Gateway should ALSO have received it (cross-project notification fan-out)
  assert.equal(sentFrames.length, 1, 'gateway delivered a notification frame');
  const notifFrame = sentFrames[0];
  assert.equal(notifFrame.type, 'notification');
  assert.equal(notifFrame.kind, 'project-report');
  assert.equal(notifFrame.projectId, 'project-b');

  // Ref should be from primary
  assert.ok(ref.conduit !== '');
  assert.ok(ref.messageId !== '');
});

// ── Test: interactive-reply routing ───────────────────────────────

test('CompositeAdapter: interactive-reply to Slack conduit does NOT hit gateway', async () => {
  const primary = new MockAdapter({ adminChannel: 'C-admin' });
  const gateway = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  const composite = new CompositeAdapter([primary, gateway]);

  // Set up TUI connection
  const sentFrames: any[] = [];
  const mockWs = {
    send: (data: string) => { sentFrames.push(JSON.parse(data)); },
    close: () => {},
    on: () => {},
  } as unknown as WebSocket;
  const conn = new TuiConnection('tui-reply-1', mockWs, 'general');
  gateway.connections.set('tui-reply-1', conn);

  // Post interactive-reply to a Slack-style conduit
  const ref = await composite.postMessage(
    { type: 'interactive-reply', conduit: 'C12345', sessionId: '' },
    { text: 'slack reply' },
  );

  // Only primary should get it
  assert.equal(primary.posted.length, 1);
  assert.equal(primary.posted[0].content.text, 'slack reply');
  assert.equal(sentFrames.length, 0);
});

test('CompositeAdapter: interactive-reply to TUI conduit does NOT hit primary', async () => {
  const primary = new MockAdapter({ adminChannel: 'C-admin' });
  const gateway = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  const composite = new CompositeAdapter([primary, gateway]);

  // Set up TUI connection
  const sentFrames: any[] = [];
  const mockWs = {
    send: (data: string) => { sentFrames.push(JSON.parse(data)); },
    close: () => {},
    on: () => {},
  } as unknown as WebSocket;
  const conn = new TuiConnection('tui-reply-2', mockWs, 'general');
  gateway.connections.set('tui-reply-2', conn);

  // Post interactive-reply to a TUI-style conduit
  await composite.postMessage(
    { type: 'interactive-reply', conduit: 'tui-reply-2', sessionId: '' },
    { text: 'tui reply' },
  );

  // Only gateway should get it
  assert.equal(primary.posted.length, 0);
  assert.equal(sentFrames.length, 1);
  assert.equal(sentFrames[0].type, 'chat.post');
  assert.equal(sentFrames[0].content.text, 'tui reply');
});

// ── Test: system-notice goes to primary only ──────────────────────

test('CompositeAdapter: system-notice goes to primary only', async () => {
  const primary = new MockAdapter({ adminChannel: 'C-admin' });
  const gateway = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  const composite = new CompositeAdapter([primary, gateway]);

  const sentFrames: any[] = [];
  const mockWs = {
    send: (data: string) => { sentFrames.push(JSON.parse(data)); },
    close: () => {},
    on: () => {},
  } as unknown as WebSocket;
  const conn = new TuiConnection('tui-sys-1', mockWs, 'general');
  gateway.connections.set('tui-sys-1', conn);

  await composite.postMessage(
    { type: 'system-notice' },
    { text: 'system notice' },
  );

  // Only primary should get system-notice
  assert.equal(primary.posted.length, 1);
  assert.equal(primary.posted[0].content.text, 'system notice');
  assert.equal(primary.posted[0].destination.type, 'system-notice');
  assert.equal(sentFrames.length, 0);
});

// ── Test: openModal routing ───────────────────────────────────────

test('CompositeAdapter: openModal routes by triggerId prefix', async () => {
  const primary = new MockAdapter({ adminChannel: 'C-admin' });
  const gateway = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  const composite = new CompositeAdapter([primary, gateway]);

  const modal = {
    callbackId: 'test-modal',
    title: 'Test',
    fields: [],
  };

  // TUI triggerId → routes to gateway
  await composite.openModal('tui:conduit1:uuid', modal);
  assert.equal(primary.modals.length, 0); // primary not called

  // Primary triggerId → routes to primary
  await composite.openModal('slack-trigger-123', modal);
  assert.equal(primary.modals.length, 1);
  assert.equal(primary.modals[0].triggerId, 'slack-trigger-123');
});

// ── Test: capabilities merging ────────────────────────────────────

test('CompositeAdapter: capabilities merge union/intersection/min correctly', async () => {
  const primary = new MockAdapter({
    capabilities: {
      threads: true,
      messageEdit: true,
      fileUpload: true,
      modals: true,
      richFormatting: true,
      reactions: true,
      maxMessageLength: 3000,
      maxThreadDepth: 1,
    },
  });
  const gateway = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  const composite = new CompositeAdapter([primary, gateway]);

  const c = composite.capabilities;

  // Union: threads / messageEdit / fileUpload
  assert.equal(c.threads, true);
  assert.equal(c.messageEdit, true);
  assert.equal(c.fileUpload, true);

  // Intersection: modals (both true → true)
  assert.equal(c.modals, true);

  // Min
  assert.equal(c.maxMessageLength, Math.min(3000, 100_000));
});

test('CompositeAdapter: modals=false when one side lacks it (intersection)', async () => {
  // Gateway has modals: true (default), but primary has modals: false
  const primary = new MockAdapter({
    adminChannel: 'C-admin',
    capabilities: { modals: false },
  });
  const gateway = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  const composite = new CompositeAdapter([primary, gateway]);

  assert.equal(composite.capabilities.modals, false);
});

// ── Test: N-ary routing (Slack + Feishu + TUI) ────────────────────

/** A MockAdapter that owns a specific conduit prefix (simulates Slack/Feishu). */
function prefixAdapter(prefix: string): MockAdapter {
  const a = new MockAdapter({ adminChannel: `${prefix}admin` });
  a.ownsConduitFn = (c: string) => c.startsWith(prefix);
  return a;
}

test('CompositeAdapter: routes update/delete/permalink/markQueued by conduit prefix', async () => {
  const slack = prefixAdapter('slack:');
  const feishu = prefixAdapter('feishu:');
  const composite = new CompositeAdapter([slack, feishu]);

  await composite.updateMessage({ conduit: 'slack:C1', messageId: 'm1' }, { text: 'u' });
  await composite.updateMessage({ conduit: 'feishu:oc_1', messageId: 'm2' }, { text: 'u' });
  await composite.deleteMessage({ conduit: 'feishu:oc_2', messageId: 'm3' });
  await composite.markQueued({ conduit: 'slack:C2', messageId: 'm4' });
  const link = await composite.getPermalink({ conduit: 'feishu:oc_3', messageId: 'm5' });

  assert.equal(slack.updated.length, 1);
  assert.equal(slack.updated[0].ref.conduit, 'slack:C1');
  assert.equal(feishu.updated.length, 1);
  assert.equal(feishu.updated[0].ref.conduit, 'feishu:oc_1');
  assert.equal(slack.deleted.length, 0);
  assert.equal(feishu.deleted.length, 1);
  assert.equal(slack.marksQueued.length, 1);
  assert.equal(feishu.marksQueued.length, 0);
  assert.ok(link?.includes('feishu:oc_3'));
});

test('CompositeAdapter: interactive-reply routes to the owning platform only', async () => {
  const slack = prefixAdapter('slack:');
  const feishu = prefixAdapter('feishu:');
  const composite = new CompositeAdapter([slack, feishu]);

  await composite.postMessage({ type: 'interactive-reply', conduit: 'feishu:oc_9', sessionId: '' }, { text: 'hi' });

  assert.equal(slack.posted.length, 0);
  assert.equal(feishu.posted.length, 1);
});

test('CompositeAdapter: system-notice fans out to all real primaries (not TUI)', async () => {
  const slack = prefixAdapter('slack:');
  const feishu = prefixAdapter('feishu:');
  const gateway = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  const composite = new CompositeAdapter([slack, feishu, gateway]);

  await composite.postMessage({ type: 'system-notice' }, { text: 'boot' });

  assert.equal(slack.posted.length, 1);
  assert.equal(feishu.posted.length, 1);
  assert.equal(slack.posted[0].destination.type, 'system-notice');
});

test('CompositeAdapter: project-report targets ALL real primaries (unbound primary falls back to its own DM)', async () => {
  const slack = prefixAdapter('slack:');
  const feishu = prefixAdapter('feishu:');
  const composite = new CompositeAdapter([slack, feishu]);

  // Bind the project ONLY in slack; feishu has no binding for it.
  await slack.bindProjectConduit('proj-x', 'slack:C1');

  await composite.postMessage(
    { type: 'project-report', projectId: 'proj-x', trigger: 'test', sessionId: '' },
    { text: 'report' },
  );

  // Slack posts to its bound channel; feishu is STILL targeted so it can
  // independently fall back to its own admin DM (the bound→DM→drop decision
  // happens inside the real adapter; MockAdapter here just records delivery).
  assert.equal(slack.posted.length, 1, 'bound slack primary receives the report');
  assert.equal(feishu.posted.length, 1, 'unbound feishu primary is still targeted for DM fallback');
});

test('CompositeAdapter: project-report does NOT target TUI gateway when it has no live conduit', async () => {
  const primary = new MockAdapter({ adminChannel: 'C-admin' });
  const gateway = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  const composite = new CompositeAdapter([primary, gateway]);

  const sentFrames: any[] = [];
  const mockWs = {
    send: (data: string) => { sentFrames.push(JSON.parse(data)); },
    close: () => {},
    on: () => {},
  } as unknown as WebSocket;
  const conn = new TuiConnection('tui-none-1', mockWs, 'general');
  gateway.connections.set('tui-none-1', conn);
  // No setConduitState → gateway.getProjectConduits() is empty.

  await composite.postMessage(
    { type: 'project-report', projectId: 'orphan-proj', trigger: 'test', sessionId: '' },
    { text: 'report' },
  );

  // Primary is always targeted (falls back to its admin DM internally);
  // TUI gateway is NOT, since it has no admin-DM concept and no live conduit.
  assert.equal(primary.posted.length, 1);
  assert.equal(sentFrames.length, 0, 'gateway not targeted without a live conduit');
});

test('CompositeAdapter: downloadFile routes by fileRef.conduit, falls back to first', async () => {
  const slack = prefixAdapter('slack:');
  const feishu = prefixAdapter('feishu:');
  const composite = new CompositeAdapter([slack, feishu]);

  const r1 = await composite.downloadFile(
    { id: 'F1', name: 'a', mimetype: 'text/plain', url: '', conduit: 'feishu:oc_1', raw: {} },
    '/tmp',
  );
  assert.ok(r1.localPath.includes('F1'));

  // No conduit → first adapter handles it (slack here).
  const r2 = await composite.downloadFile(
    { id: 'F2', name: 'b', mimetype: 'text/plain', url: '', raw: {} },
    '/tmp',
  );
  assert.ok(r2.localPath.includes('F2'));
});

test('CompositeAdapter: getProjectConduits merges all sub-adapters', async () => {
  const slack = prefixAdapter('slack:');
  const feishu = prefixAdapter('feishu:');
  const composite = new CompositeAdapter([slack, feishu]);

  await composite.bindProjectConduit('proj-a', 'slack:C1');
  await composite.bindProjectConduit('proj-b', 'feishu:oc_1');

  // bind routed to the owning adapter
  assert.deepEqual(await slack.getProjectConduits(), { 'proj-a': 'slack:C1' });
  assert.deepEqual(await feishu.getProjectConduits(), { 'proj-b': 'feishu:oc_1' });

  const merged = await composite.getProjectConduits();
  assert.equal(merged['proj-a'], 'slack:C1');
  assert.equal(merged['proj-b'], 'feishu:oc_1');
});

// ── Test: per-platform thread anchors (regression for cross-platform anchor leak) ──

/** Make a project-report destination. */
function projReport(projectId: string) {
  return { type: 'project-report' as const, projectId, trigger: 'test', sessionId: '' };
}

test('CompositeAdapter.postMessage: aggregates per-platform sub-refs into parts[]', async () => {
  const slack = prefixAdapter('slack:');
  const feishu = prefixAdapter('feishu:');
  // Project-report resolves to bare projectId in MockAdapter, so override to return
  // platform-prefixed conduits (mirrors real adapters returning slack:/feishu: refs).
  slack.postMessage = async () => ({ conduit: 'slack:C1', messageId: 'ts_slack' });
  feishu.postMessage = async () => ({ conduit: 'feishu:oc_1', messageId: 'om_feishu' });
  const composite = new CompositeAdapter([slack, feishu]);

  const ref = await composite.postMessage(projReport('p'), { text: 'report' });

  assert.equal(ref.conduit, 'slack:C1', 'top-level mirrors first sub-ref (back-compat)');
  assert.equal(ref.messageId, 'ts_slack');
  assert.equal(ref.parts?.length, 2, 'both platform sub-refs collected');
  assert.equal(ref.parts?.[0].conduit, 'slack:C1');
  assert.equal(ref.parts?.[1].conduit, 'feishu:oc_1');
  assert.equal(ref.parts?.[1].messageId, 'om_feishu');
});

test('CompositeAdapter.postMessage: single non-empty sub-ref returned bare (no parts)', async () => {
  const slack = prefixAdapter('slack:');
  const feishu = prefixAdapter('feishu:');
  slack.postMessage = async () => ({ conduit: 'slack:C1', messageId: 'ts_slack' });
  feishu.postMessage = async () => ({ conduit: '', messageId: '' }); // dropped (e.g. no DM)
  const composite = new CompositeAdapter([slack, feishu]);

  const ref = await composite.postMessage(projReport('p'), { text: 'report' });
  assert.equal(ref.messageId, 'ts_slack');
  assert.equal(ref.parts, undefined, 'no parts[] when only one platform posted');
});

/** Spy each sub-adapter's openOutputStream, recording the opts it received. */
function spyOpenStream(a: MockAdapter, sink: { opts?: any }): void {
  a.openOutputStream = (_d, o) => { sink.opts = o; return new RecordingOutputStream(); };
}

test('CompositeAdapter.openOutputStream: routes each sub-stream its OWN platform anchor (parts[])', async () => {
  const slack = prefixAdapter('slack:');
  const feishu = prefixAdapter('feishu:');
  const seenSlack: { opts?: any } = {};
  const seenFeishu: { opts?: any } = {};
  spyOpenStream(slack, seenSlack);
  spyOpenStream(feishu, seenFeishu);
  const composite = new CompositeAdapter([slack, feishu]);

  composite.openOutputStream(projReport('p'), {
    anchorRef: {
      conduit: 'slack:C1', messageId: 'ts_slack',
      parts: [
        { conduit: 'slack:C1', messageId: 'ts_slack' },
        { conduit: 'feishu:oc_1', messageId: 'om_feishu' },
      ],
    },
  });

  assert.equal(seenSlack.opts.threadId, 'ts_slack', 'slack stream anchors under its own ts');
  assert.equal(seenFeishu.opts.threadId, 'om_feishu', 'feishu stream anchors under its own om_ id');
  // The core regression: feishu must NEVER receive the Slack ts (caused Feishu 99992354 / HTTP 400).
  assert.notEqual(seenFeishu.opts.threadId, 'ts_slack');
  assert.equal(seenSlack.opts.anchorRef, undefined, 'anchorRef stripped before delegating');
  assert.equal(seenFeishu.opts.anchorRef, undefined);
});

test('CompositeAdapter.openOutputStream: anchorRef without parts → only owning platform anchors', async () => {
  const slack = prefixAdapter('slack:');
  const feishu = prefixAdapter('feishu:');
  const seenSlack: { opts?: any } = {};
  const seenFeishu: { opts?: any } = {};
  spyOpenStream(slack, seenSlack);
  spyOpenStream(feishu, seenFeishu);
  const composite = new CompositeAdapter([slack, feishu]);

  composite.openOutputStream(projReport('p'), {
    anchorRef: { conduit: 'slack:C1', messageId: 'ts_slack' },
  });

  assert.equal(seenSlack.opts.threadId, 'ts_slack');
  assert.equal(seenFeishu.opts.threadId, null, 'non-owning platform self-anchors (null)');
});

test('CompositeAdapter.openOutputStream: no anchorRef → legacy threadId goes to first adapter only', async () => {
  const slack = prefixAdapter('slack:');
  const feishu = prefixAdapter('feishu:');
  const seenSlack: { opts?: any } = {};
  const seenFeishu: { opts?: any } = {};
  spyOpenStream(slack, seenSlack);
  spyOpenStream(feishu, seenFeishu);
  const composite = new CompositeAdapter([slack, feishu]);

  composite.openOutputStream(projReport('p'), { threadId: 'shared' });

  assert.equal(seenSlack.opts.threadId, 'shared', 'first adapter keeps the bare threadId');
  assert.equal(seenFeishu.opts.threadId, null, 'others self-anchor to avoid cross-platform leak');
});

test('CompositeAdapter.postInteractive: aggregates per-platform sub-refs into parts[]', async () => {
  const slack = prefixAdapter('slack:');
  const feishu = prefixAdapter('feishu:');
  slack.postInteractive = async () => ({ conduit: 'slack:C1', messageId: 'ts_slack' });
  feishu.postInteractive = async () => ({ conduit: 'feishu:oc_1', messageId: 'om_feishu' });
  const composite = new CompositeAdapter([slack, feishu]);

  const ref = await composite.postInteractive(
    projReport('p'),
    { text: 'q', actions: [] },
  );
  assert.equal(ref.parts?.length, 2);
  assert.equal(ref.parts?.[1].messageId, 'om_feishu');
});

// ── Test: extractTuiAdapter ───────────────────────────────────────

test('extractTuiAdapter: returns gateway from CompositeAdapter', () => {
  const primary = new MockAdapter({ adminChannel: 'C-admin' });
  const gateway = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  const composite = new CompositeAdapter([primary, gateway]);

  const extracted = extractTuiAdapter(composite);
  assert.ok(extracted !== null);
  assert.equal(extracted, gateway);
});

test('extractTuiAdapter: returns self for bare TuiGatewayAdapter', () => {
  const gateway = new TuiGatewayAdapter({ port: 0, host: '127.0.0.1' });
  const extracted = extractTuiAdapter(gateway);
  assert.ok(extracted !== null);
  assert.equal(extracted, gateway);
});

test('extractTuiAdapter: returns null for non-TUI adapter', () => {
  const primary = new MockAdapter({ adminChannel: 'C-admin' });
  const extracted = extractTuiAdapter(primary);
  assert.equal(extracted, null);
});

// ── Test: FanOutOutputStream ──────────────────────────────────────

test('FanOutOutputStream: broadcasts emitText to all sub-streams', () => {
  const sub1 = new RecordingOutputStream();
  const sub2 = new RecordingOutputStream();
  const fanOut = new FanOutOutputStream([sub1, sub2]);

  fanOut.emitText('hello');
  fanOut.emitText('world');

  assert.equal(sub1.segments.length, 2);
  assert.equal(sub1.segments[0], 'emit:hello');
  assert.equal(sub1.segments[1], 'emit:world');
  assert.equal(sub2.segments[0], 'emit:hello');
  assert.equal(sub2.segments[1], 'emit:world');
});

test('FanOutOutputStream: openMutable returns aggregate MutableRegion that fan-outs updates', () => {
  const sub1 = new RecordingOutputStream();
  const sub2 = new RecordingOutputStream();
  const fanOut = new FanOutOutputStream([sub1, sub2]);

  const region = fanOut.openMutable('start');
  region.update('revised');

  assert.equal(sub1.segments[0], 'mutable:start');
  assert.equal(sub2.segments[0], 'mutable:start');
  assert.equal(sub1.segments[1], 'update:revised');
  assert.equal(sub2.segments[1], 'update:revised');
});

test('FanOutOutputStream: postInteractive returns first non-null ref', async () => {
  const sub1 = new RecordingOutputStream();
  sub1.postInteractive = async () => null; // override to return null
  const sub2 = new RecordingOutputStream();

  const fanOut = new FanOutOutputStream([sub1, sub2]);
  const ref = await fanOut.postInteractive('test');

  assert.ok(ref !== null);
  assert.equal(ref!.messageId, '1');
  assert.equal(sub2.refs.length, 1);
});

test('FanOutOutputStream: flush awaits all sub-streams', async () => {
  const sub1 = new RecordingOutputStream();
  const sub2 = new RecordingOutputStream();
  const fanOut = new FanOutOutputStream([sub1, sub2]);

  await fanOut.flush();

  assert.equal(sub1.segments[0], 'flush');
  assert.equal(sub2.segments[0], 'flush');
});

test('FanOutOutputStream: getRefs concatenates all sub-stream refs', () => {
  const sub1 = new RecordingOutputStream();
  const sub2 = new RecordingOutputStream();

  // Both sub-streams have auto-created refs from postInteractive
  const fanOut = new FanOutOutputStream([sub1, sub2]);
  // Trigger ref creation by calling postInteractive
  fanOut.postInteractive('a');
  fanOut.postInteractive('b');

  const refs = fanOut.getRefs();
  assert.equal(refs.length, sub1.refs.length + sub2.refs.length);
});

test('FanOutOutputStream: getParentRef returns first sub-stream parent', () => {
  const sub1 = new RecordingOutputStream();
  const sub2 = new RecordingOutputStream();
  const fanOut = new FanOutOutputStream([sub1, sub2]);

  // No parent ref set yet
  assert.equal(fanOut.getParentRef(), null);

  // After postInteractive, parent refs are set on sub-streams
  fanOut.postInteractive('first');

  const parent = fanOut.getParentRef();
  assert.ok(parent !== null);
});
