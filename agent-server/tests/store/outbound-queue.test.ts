// input:  Node test runner, assert, tmp filesystem
// output: regression tests for OutboundQueue (WAL persistence, drain, recover, compact, TTL)
// pos:    verifies store/outbound-queue.ts WAL guarantees
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OutboundQueue } from '../../src/store/outbound-queue.js';
import type { PlatformAdapter } from '../../src/platform/adapter.js';
import type { Destination, MessageRef, MessageContent, PlatformCapabilities, PostMessageOpts } from '../../src/platform/types.js';

// ── Shared tmp directory ───────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-outbound-queue-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Helper: build test destination ────────────────────────────────

function testDest(channel: string): Destination {
  return { type: 'interactive-reply', conduit: channel, sessionId: '' };
}

// ── Mock adapter ───────────────────────────────────────────────

function createMockAdapter(overrides: {
  postMessage?: (destination: Destination, content: MessageContent, opts?: PostMessageOpts) => Promise<MessageRef>;
  updateMessage?: (ref: MessageRef, content: MessageContent) => Promise<void>;
} = {}): PlatformAdapter {
  let postCount = 0;
  return {
    name: 'mock',
    capabilities: { threads: true, messageEdit: true, maxMessageLength: 3000 } as PlatformCapabilities,
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    onAction: () => {},
    onModalSubmit: () => {},
    onMessageEdit: () => {},
    postMessage: overrides.postMessage ?? (async (destination: Destination, _content: MessageContent, opts?: PostMessageOpts): Promise<MessageRef> => {
      postCount++;
      const channel = destination.type === 'interactive-reply' ? destination.conduit : 'unknown';
      return { conduit: channel, messageId: `mock-ts-${postCount}`, threadId: opts?.threadId };
    }),
    updateMessage: overrides.updateMessage ?? (async () => {}),
    deleteMessage: async () => {},
    postInteractive: async (destination: Destination) => {
      const channel = destination.type === 'interactive-reply' ? destination.conduit : 'unknown';
      return { conduit: channel, messageId: 'mock-interactive' };
    },
    openModal: async () => {},
    markQueued: async () => {},
    uploadFile: async () => {},
    downloadFile: async () => ({ localPath: '', mimetype: '', name: '' }),
    getPermalink: async () => null,
  } as any;
}

// ── Helper: fresh queue per test ───────────────────────────────

let _testIdx = 0;
function createQueue(adapter?: PlatformAdapter, opts?: { ttlMs?: number }): { queue: OutboundQueue; walPath: string } {
  const idx = _testIdx++;
  const walPath = path.join(tmpDir, `outbound-wal-${idx}.jsonl`);
  const queue = new OutboundQueue({
    walPath,
    adapter: adapter ?? createMockAdapter(),
    ttlMs: opts?.ttlMs,
  });
  return { queue, walPath };
}

// ── enqueue persists to WAL ────────────────────────────────────

test('OutboundQueue - enqueue writes entry to WAL file', async () => {
  const { queue, walPath } = createQueue();

  const id = await queue.enqueue({
    type: 'post',
    channel: 'C123',
    destination: testDest('C123'),
    text: 'hello world',
  });

  assert.ok(id, 'enqueue returns a non-empty id');
  const raw = await fs.readFile(walPath, 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.op, 'enqueue');
  assert.equal(parsed.id, id);
  assert.equal(parsed.channel, 'C123');
  assert.equal(parsed.text, 'hello world');
  assert.equal(parsed.type, 'post');
  assert.equal(parsed.status, 'pending');
});

test('OutboundQueue - multiple enqueue appends to WAL', async () => {
  const { queue, walPath } = createQueue();

  await queue.enqueue({ type: 'post', channel: 'C1', destination: testDest('C1'), text: 'msg1' });
  await queue.enqueue({ type: 'post', channel: 'C2', destination: testDest('C2'), text: 'msg2' });
  await queue.enqueue({ type: 'update', channel: 'C1', text: 'msg3', messageId: 'ts1' });

  const raw = await fs.readFile(walPath, 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 3);
});

// ── markSent records completion in WAL ─────────────────────────

test('OutboundQueue - markSent appends sent op to WAL', async () => {
  const { queue, walPath } = createQueue();

  const id = await queue.enqueue({ type: 'post', channel: 'C1', destination: testDest('C1'), text: 'hello' });
  await queue.markSent(id, 'slack-ts-123');

  const raw = await fs.readFile(walPath, 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 2);
  const sentOp = JSON.parse(lines[1]);
  assert.equal(sentOp.op, 'sent');
  assert.equal(sentOp.id, id);
  assert.equal(sentOp.slackTs, 'slack-ts-123');
});

// ── recover: rebuild pending from WAL ──────────────────────────

test('OutboundQueue - recover returns count of pending entries', async () => {
  const { queue, walPath } = createQueue();

  // Seed WAL: 3 enqueued, 1 sent
  const id1 = await queue.enqueue({ type: 'post', channel: 'C1', destination: testDest('C1'), text: 'msg1' });
  await queue.enqueue({ type: 'post', channel: 'C2', destination: testDest('C2'), text: 'msg2' });
  await queue.enqueue({ type: 'post', channel: 'C3', destination: testDest('C3'), text: 'msg3' });
  await queue.markSent(id1, 'ts1');

  // New queue instance reads from same WAL
  const queue2 = new OutboundQueue({
    walPath,
    adapter: createMockAdapter(),
  });
  const count = await queue2.recover();
  assert.equal(count, 2, 'should recover 2 pending entries');
});

test('OutboundQueue - recover with empty WAL returns 0', async () => {
  const walPath = path.join(tmpDir, `outbound-wal-empty-${_testIdx++}.jsonl`);
  const queue = new OutboundQueue({ walPath, adapter: createMockAdapter() });
  const count = await queue.recover();
  assert.equal(count, 0);
});

test('OutboundQueue - recover with missing WAL file returns 0', async () => {
  const walPath = path.join(tmpDir, `outbound-wal-missing-${_testIdx++}.jsonl`);
  const queue = new OutboundQueue({ walPath, adapter: createMockAdapter() });
  const count = await queue.recover();
  assert.equal(count, 0);
});

// A full disk truncates an append mid-line; the next append starts at the truncated offset and
// glues two records into one unparseable line. recover() must skip it, not reject — it is awaited
// from the unguarded startup path, so throwing here aborts the rest of server boot.
test('OutboundQueue - recover skips a torn WAL line instead of throwing', async () => {
  const walPath = path.join(tmpDir, `outbound-wal-torn-${_testIdx++}.jsonl`);
  const good1 = { op: 'enqueue', id: 'a', ts: new Date().toISOString(), type: 'post', channel: 'c1', text: 'first', status: 'pending' };
  const good2 = { op: 'enqueue', id: 'b', ts: new Date().toISOString(), type: 'post', channel: 'c2', text: 'second', status: 'pending' };
  const torn = '{"op":"enqueue","id":"truncated","ts":"2026-07-28T21:41:05.412Z","type":"post","channel":"","text":"cut off here';
  await fs.writeFile(walPath, `${JSON.stringify(good1)}\n${torn}\n${JSON.stringify(good2)}\n`, 'utf8');

  const queue = new OutboundQueue({ walPath, adapter: createMockAdapter() });
  const count = await queue.recover();
  assert.equal(count, 2, 'both intact entries recover; only the torn line is dropped');
});

// ── drain: sends pending entries via adapter ───────────────────

test('OutboundQueue - drain sends pending post entries', async () => {
  const posted: { channel: string; text: string }[] = [];
  const adapter = createMockAdapter({
    postMessage: async (destination: Destination, content) => {
      const channel = destination.type === 'interactive-reply' ? destination.conduit : 'unknown';
      posted.push({ channel, text: content.text });
      return { conduit: channel, messageId: `ts-${posted.length}` };
    },
  });

  const { queue, walPath } = createQueue(adapter);
  await queue.enqueue({ type: 'post', channel: 'C1', destination: testDest('C1'), text: 'hello' });
  await queue.enqueue({ type: 'post', channel: 'C2', destination: testDest('C2'), text: 'world', threadId: 'th1' });

  // Recover + drain (simulating restart)
  const queue2 = new OutboundQueue({ walPath, adapter });
  await queue2.recover();
  await queue2.drain();

  assert.equal(posted.length, 2);
  assert.equal(posted[0].channel, 'C1');
  assert.equal(posted[0].text, 'hello');
  assert.equal(posted[1].channel, 'C2');
  assert.equal(posted[1].text, 'world');
});

test('OutboundQueue - drain sends pending update entries', async () => {
  const updated: { channel: string; messageId: string; text: string }[] = [];
  const adapter = createMockAdapter({
    updateMessage: async (ref, content) => {
      updated.push({ channel: ref.conduit, messageId: ref.messageId, text: content.text });
    },
  });

  const { queue, walPath } = createQueue(adapter);
  await queue.enqueue({ type: 'update', channel: 'C1', messageId: 'orig-ts', text: 'updated content' });

  const queue2 = new OutboundQueue({ walPath, adapter });
  await queue2.recover();
  await queue2.drain();

  assert.equal(updated.length, 1);
  assert.equal(updated[0].messageId, 'orig-ts');
  assert.equal(updated[0].text, 'updated content');
});

test('OutboundQueue - drain falls back to post when update fails', async () => {
  const posted: { channel: string; text: string }[] = [];
  const adapter = createMockAdapter({
    updateMessage: async () => { throw new Error('message_not_found'); },
    postMessage: async (destination: Destination, content) => {
      const channel = destination.type === 'interactive-reply' ? destination.conduit : 'unknown';
      posted.push({ channel, text: content.text });
      return { conduit: channel, messageId: 'fallback-ts' };
    },
  });

  const { queue, walPath } = createQueue(adapter);
  await queue.enqueue({ type: 'update', channel: 'C1', messageId: 'dead-ts', text: 'orphan update' });

  const queue2 = new OutboundQueue({ walPath, adapter });
  await queue2.recover();
  await queue2.drain();

  assert.equal(posted.length, 1, 'should fall back to post');
  assert.equal(posted[0].text, 'orphan update');
});

test('OutboundQueue - drain marks sent entries and does not re-send', async () => {
  let postCount = 0;
  const adapter = createMockAdapter({
    postMessage: async (_destination: Destination) => {
      postCount++;
      return { conduit: 'C1', messageId: `ts-${postCount}` };
    },
  });

  const { queue, walPath } = createQueue(adapter);
  await queue.enqueue({ type: 'post', channel: 'C1', destination: testDest('C1'), text: 'once' });

  // First drain
  const queue2 = new OutboundQueue({ walPath, adapter });
  await queue2.recover();
  await queue2.drain();
  assert.equal(postCount, 1);

  // Second drain — should not re-send
  await queue2.drain();
  assert.equal(postCount, 1, 'sent entries should not be re-sent');
});

// ── drain: coalesce multiple updates to same message ───────────

test('OutboundQueue - drain coalesces multiple updates to same message', async () => {
  const updated: { text: string }[] = [];
  const adapter = createMockAdapter({
    updateMessage: async (_ref, content) => {
      updated.push({ text: content.text });
    },
  });

  const { queue, walPath } = createQueue(adapter);
  await queue.enqueue({ type: 'update', channel: 'C1', messageId: 'ts1', text: 'v1' });
  await queue.enqueue({ type: 'update', channel: 'C1', messageId: 'ts1', text: 'v2' });
  await queue.enqueue({ type: 'update', channel: 'C1', messageId: 'ts1', text: 'v3' });

  const queue2 = new OutboundQueue({ walPath, adapter });
  await queue2.recover();
  await queue2.drain();

  assert.equal(updated.length, 1, 'should coalesce to one update');
  assert.equal(updated[0].text, 'v3', 'should send latest content');
});

// ── TTL: expire old entries ────────────────────────────────────

test('OutboundQueue - drain skips entries older than TTL', async () => {
  let postCount = 0;
  const adapter = createMockAdapter({
    postMessage: async (_destination: Destination) => {
      postCount++;
      return { conduit: 'C1', messageId: `ts-${postCount}` };
    },
  });

  const walPath = path.join(tmpDir, `outbound-wal-ttl-${_testIdx++}.jsonl`);

  // Seed WAL with an old entry (timestamp 1h ago)
  const oldTs = new Date(Date.now() - 3600_000).toISOString();
  const entry = JSON.stringify({
    op: 'enqueue', id: 'old-1', ts: oldTs, type: 'post',
    channel: 'C1', destination: { type: 'interactive-reply', conduit: 'C1', sessionId: '' }, text: 'expired', status: 'pending',
  });
  await fs.writeFile(walPath, entry + '\n');

  // TTL = 30 minutes
  const queue = new OutboundQueue({ walPath, adapter, ttlMs: 30 * 60 * 1000 });
  await queue.recover();
  await queue.drain();

  assert.equal(postCount, 0, 'expired entries should not be sent');
});

test('OutboundQueue - drain sends entries within TTL', async () => {
  let postCount = 0;
  const adapter = createMockAdapter({
    postMessage: async (_destination: Destination) => {
      postCount++;
      return { conduit: 'C1', messageId: `ts-${postCount}` };
    },
  });

  const { queue } = createQueue(adapter, { ttlMs: 30 * 60 * 1000 });
  await queue.enqueue({ type: 'post', channel: 'C1', destination: testDest('C1'), text: 'fresh' });

  // Simulate restart
  await queue.drain();

  // drain on same instance processes the entry since it was just enqueued
  // (pending map was populated by enqueue)
  assert.equal(postCount, 1, 'fresh entries should be sent');
});

// ── compact: remove sent entries from WAL ──────────────────────

test('OutboundQueue - compact removes sent entries from WAL file', async () => {
  const { queue, walPath } = createQueue();

  const id1 = await queue.enqueue({ type: 'post', channel: 'C1', destination: testDest('C1'), text: 'sent-msg' });
  await queue.enqueue({ type: 'post', channel: 'C2', destination: testDest('C2'), text: 'pending-msg' });
  await queue.markSent(id1, 'ts1');

  await queue.compact();

  const raw = await fs.readFile(walPath, 'utf8');
  const lines = raw.trim().split('\n').filter(l => l.trim());
  assert.equal(lines.length, 1, 'only pending entry remains');
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.text, 'pending-msg');
});

test('OutboundQueue - compact on empty WAL creates empty file', async () => {
  const { queue, walPath } = createQueue();
  const id = await queue.enqueue({ type: 'post', channel: 'C1', destination: testDest('C1'), text: 'msg' });
  await queue.markSent(id);
  await queue.compact();

  const raw = await fs.readFile(walPath, 'utf8');
  assert.equal(raw.trim(), '', 'WAL should be empty after compacting all-sent entries');
});

// ── concurrent enqueue: no lost entries ────────────────────────

test('OutboundQueue - 10 concurrent enqueue produce all 10 entries', async () => {
  const { queue, walPath } = createQueue();

  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      queue.enqueue({ type: 'post', channel: `C${i}`, destination: testDest(`C${i}`), text: `msg-${i}` })
    )
  );

  const raw = await fs.readFile(walPath, 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 10, 'all 10 entries should be written');
  const channels = new Set(lines.map(l => JSON.parse(l).channel));
  assert.equal(channels.size, 10);
});

// ── flush: drain mutex queue ───────────────────────────────────

test('OutboundQueue - flush resolves after all pending WAL writes', async () => {
  const { queue } = createQueue();

  // Fire off several enqueues
  const promises = Array.from({ length: 5 }, (_, i) =>
    queue.enqueue({ type: 'post', channel: 'C1', destination: testDest('C1'), text: `msg-${i}` })
  );

  await queue.flush();
  // All enqueues should have completed by now
  const ids = await Promise.all(promises);
  assert.equal(ids.length, 5);
});

// ── drain handles adapter errors gracefully ────────────────────

test('OutboundQueue - drain retries on transient adapter failure', async () => {
  let attempt = 0;
  const adapter = createMockAdapter({
    postMessage: async (_destination: Destination) => {
      attempt++;
      if (attempt === 1) throw new Error('transient');
      return { conduit: 'C1', messageId: 'ts-ok' };
    },
  });

  const { queue } = createQueue(adapter);
  await queue.enqueue({ type: 'post', channel: 'C1', destination: testDest('C1'), text: 'retry-me' });

  // First drain: fails, entry stays pending
  await queue.drain();
  // Second drain: succeeds
  await queue.drain();

  assert.equal(attempt, 2, 'should have retried on second drain');
});

// ── richBlocks preservation ────────────────────────────────────

test('OutboundQueue - enqueue preserves richBlocks in WAL', async () => {
  const { queue, walPath } = createQueue();

  await queue.enqueue({
    type: 'post',
    channel: 'C1',
    destination: testDest('C1'),
    text: 'with blocks',
    richBlocks: [{ type: 'markdown', text: '**bold**' }],
  });

  const raw = await fs.readFile(walPath, 'utf8');
  const parsed = JSON.parse(raw.trim());
  assert.deepEqual(parsed.richBlocks, [{ type: 'markdown', text: '**bold**' }]);
});

// ── getPendingCount ────────────────────────────────────────────

test('OutboundQueue - getPendingCount reflects enqueue and markSent', async () => {
  const { queue } = createQueue();

  assert.equal(queue.getPendingCount(), 0);
  const id1 = await queue.enqueue({ type: 'post', channel: 'C1', destination: testDest('C1'), text: 'a' });
  await queue.enqueue({ type: 'post', channel: 'C2', destination: testDest('C2'), text: 'b' });
  assert.equal(queue.getPendingCount(), 2);
  await queue.markSent(id1);
  assert.equal(queue.getPendingCount(), 1);
});
