import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/events/event-bus.js';
import { ctx as jobCtx } from '../../src/domain/scheduling/job-registry.js';
import { publishSessionMessage } from '../../src/orchestration/session-events.js';

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

test('publishSessionMessage is a no-op when no bus is wired', () => {
  const prev = jobCtx.bus;
  jobCtx.bus = null;
  try {
    assert.doesNotThrow(() => publishSessionMessage({ sessionId: 's', channel: 'c', role: 'user', text: 'x' }));
  } finally {
    jobCtx.bus = prev;
  }
});
