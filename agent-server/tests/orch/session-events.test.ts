// input:  session event publishers and an isolated shared EventBus
// output: context/message/notice/pending/delta/delivery event regressions
// pos:    Orchestration session-event contract specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/events/event-bus.js';
import { ctx as jobCtx } from '../../src/domain/scheduling/job-registry.js';
import { publishSessionContextUsage, publishSessionDebugUpdated, publishSessionMessage, publishSessionMessageDelta, publishSessionMessageDelivered } from '../../src/orchestration/session-events.js';

test('publishSessionContextUsage emits the complete timestamped snapshot', () => {
  const bus = new EventBus();
  const seen: any[] = [];
  bus.subscribe('session.context-usage', (event) => { seen.push(event); });
  const prev = jobCtx.bus;
  jobCtx.bus = bus;
  try {
    publishSessionContextUsage({
      sessionId: 'sess-context', channel: 'web:context', usedTokens: 60000,
      contextWindow: 200000, percent: 30, accuracy: 'estimate',
      updatedAt: '2026-07-27T12:00:00.000Z',
    });
  } finally {
    jobCtx.bus = prev;
  }

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    type: 'session.context-usage', ts: seen[0].ts,
    sessionId: 'sess-context', channel: 'web:context', usedTokens: 60000,
    contextWindow: 200000, percent: 30, accuracy: 'estimate',
    updatedAt: '2026-07-27T12:00:00.000Z',
  });
});

test('publishSessionDebugUpdated emits a content-free transcript refresh hint', () => {
  const bus = new EventBus();
  const seen: any[] = [];
  bus.subscribe('session.debug.updated', (event) => { seen.push(event); });
  const prev = jobCtx.bus;
  jobCtx.bus = bus;
  try {
    publishSessionDebugUpdated({ sessionId: 'sess-debug', channel: 'web:debug' });
  } finally {
    jobCtx.bus = prev;
  }

  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['channel', 'sessionId', 'ts', 'type']);
  assert.equal(seen[0].type, 'session.debug.updated');
  assert.equal(seen[0].sessionId, 'sess-debug');
  assert.ok(!JSON.stringify(seen[0]).includes('secret'), 'no prompt, input, or result content enters the event bus');
});

test('publishSessionMessage emits a session.message event on the shared bus', () => {
  const bus = new EventBus();
  const seen: any[] = [];
  bus.subscribe('session.message', (e) => { seen.push(e); });

  const prev = jobCtx.bus;
  jobCtx.bus = bus;
  try {
    publishSessionMessage({ sessionId: 'sess-1', channel: 'C1', role: 'assistant', text: 'hi there' });
    publishSessionMessage({ sessionId: 'sess-1', channel: 'C1', role: 'tool', text: '', toolName: 'Read', toolInput: 'x.ts' });
  } finally {
    jobCtx.bus = prev;
  }

  assert.equal(seen.length, 2);
  assert.equal(seen[0].type, 'session.message');
  assert.equal(seen[0].sessionId, 'sess-1');
  assert.equal(seen[0].channel, 'C1');
  assert.equal(seen[0].role, 'assistant');
  assert.equal(seen[0].text, 'hi there');
  assert.ok(typeof seen[0].ts === 'string');
  assert.equal(seen[1].role, 'tool');
  assert.equal(seen[1].toolName, 'Read');
});

test('publishSessionMessage carries an optional notice level', () => {
  const bus = new EventBus();
  const seen: any[] = [];
  bus.subscribe('session.message', (event) => { seen.push(event); });

  const prev = jobCtx.bus;
  jobCtx.bus = bus;
  try {
    publishSessionMessage({
      sessionId: 'sess-notice',
      channel: 'web:notice',
      role: 'assistant',
      text: 'Context auto-compacted.',
      noticeLevel: 'info',
    });
  } finally {
    jobCtx.bus = prev;
  }

  assert.equal(seen[0].noticeLevel, 'info');
});

test('publishSessionMessage forwards a notice action to the live stream', () => {
  const seen: any[] = [];
  const bus = { publish: (e: any) => seen.push(e) } as any;
  const prev = jobCtx.bus;
  jobCtx.bus = bus;
  try {
    publishSessionMessage({
      sessionId: 'sess-action',
      channel: 'web:notice',
      role: 'assistant',
      text: 'Rate limited',
      noticeLevel: 'warning',
      noticeAction: { kind: 'cancel-resume' },
    });
  } finally {
    jobCtx.bus = prev;
  }

  assert.deepEqual(seen[0].noticeAction, { kind: 'cancel-resume' });
});

test('publishSessionMessage is a no-op when no bus is wired', () => {
  const prev = jobCtx.bus;
  jobCtx.bus = null;
  try {
    assert.doesNotThrow(() => publishSessionMessage({ sessionId: 's', channel: 'c', role: 'user', text: 'x' }));
  } finally {
    jobCtx.bus = prev;
  }
});

test('publishSessionMessage carries the blockId that ties it to its streamed deltas', () => {
  const bus = new EventBus();
  const seen: any[] = [];
  bus.subscribe('session.message', (e) => { seen.push(e); });

  const prev = jobCtx.bus;
  jobCtx.bus = bus;
  try {
    publishSessionMessage({ sessionId: 's1', channel: 'web:c', role: 'assistant', text: 'full', blockId: 'msg_A:1' });
    publishSessionMessage({ sessionId: 's1', channel: 'web:c', role: 'assistant', text: 'unstreamed' });
  } finally {
    jobCtx.bus = prev;
  }

  assert.equal(seen[0].blockId, 'msg_A:1');
  assert.ok(!('blockId' in seen[1]), 'a message that never streamed carries no blockId at all');
});

test('publishSessionMessage marks a message the model has not read yet with a stable pending id', () => {
  const bus = new EventBus();
  const seen: any[] = [];
  bus.subscribe('session.message', (e) => { seen.push(e); });

  const prev = jobCtx.bus;
  jobCtx.bus = bus;
  try {
    publishSessionMessage({ sessionId: 's1', channel: 'web:c', role: 'user', text: 'stop', ts: 'T1', pending: true, pendingId: 'pin-1' });
    publishSessionMessage({ sessionId: 's1', channel: 'web:c', role: 'user', text: 'ordinary' });
  } finally {
    jobCtx.bus = prev;
  }

  assert.equal(seen[0].pending, true);
  assert.equal(seen[0].pendingId, 'pin-1');
  assert.ok(!('pending' in seen[1]), 'an ordinary message carries no pending marker at all');
  assert.ok(!('pendingId' in seen[1]), 'an ordinary message carries no pending identity');
});

test('publishSessionMessageDelivered carries stable pending identity and both row keys', () => {
  const bus = new EventBus();
  const seen: any[] = [];
  bus.subscribe('session.message.delivered', (e) => { seen.push(e); });

  const prev = jobCtx.bus;
  jobCtx.bus = bus;
  try {
    publishSessionMessageDelivered({ sessionId: 's1', channel: 'web:c', pendingId: 'pin-1', messageTs: 'T-write', committedTs: 'T-read' });
  } finally {
    jobCtx.bus = prev;
  }

  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'session.message.delivered');
  assert.equal(seen[0].pendingId, 'pin-1');
  assert.equal(seen[0].messageTs, 'T-write', 'the row the client is currently showing dimmed');
  assert.equal(seen[0].committedTs, 'T-read', 'the key a transcript refetch will return it under');
});

test('publishSessionMessageDelta emits a session.message.delta event', () => {
  const bus = new EventBus();
  const seen: any[] = [];
  bus.subscribe('session.message.delta', (e) => { seen.push(e); });

  const prev = jobCtx.bus;
  jobCtx.bus = bus;
  try {
    publishSessionMessageDelta({ sessionId: 's1', channel: 'web:c', blockId: 'msg_A:1', text: 'Tea ', seq: 0 });
    publishSessionMessageDelta({ sessionId: 's1', channel: 'web:c', blockId: 'msg_A:1', text: 'is a leaf.', seq: 1 });
  } finally {
    jobCtx.bus = prev;
  }

  assert.equal(seen.length, 2);
  assert.equal(seen[0].type, 'session.message.delta');
  assert.equal(seen[0].sessionId, 's1');
  assert.equal(seen[0].channel, 'web:c');
  assert.equal(seen[0].blockId, 'msg_A:1');
  assert.equal(seen[0].text, 'Tea ');
  assert.equal(seen[0].seq, 0);
  assert.ok(typeof seen[0].ts === 'string');
  assert.equal(seen[1].seq, 1);
});

test('publishSessionMessageDelta is a no-op when no bus is wired', () => {
  const prev = jobCtx.bus;
  jobCtx.bus = null;
  try {
    assert.doesNotThrow(() => publishSessionMessageDelta({ sessionId: 's', channel: 'c', blockId: 'b', text: 'x', seq: 0 }));
  } finally {
    jobCtx.bus = prev;
  }
});
