// input:  EventBus, createEventLogger
// output: regression tests for events/ layer (S4 spec requirements)
// pos:    verifies fan-out order, handler error isolation, logger backpressure,
//         SIGTERM flush, and CORTEX_EVENT_LOG=off
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventBus } from '../../src/events/event-bus.js';
import { createEventLogger } from '../../src/events/event-logger.js';
import type { CortexEvent } from '../../src/events/event-types.js';

// ── Shared tmp directory ───────────────────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-events-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── (a) fan-out order ─────────────────────────────────────────────────────

test('fan-out order — handlers called in subscription-registration order', () => {
  const bus = new EventBus();
  const order: string[] = [];

  bus.subscribe('scheduler.tick', () => { order.push('h1'); });
  bus.subscribe('scheduler.tick', () => { order.push('h2'); });
  bus.subscribe('*', () => { order.push('h3'); });

  bus.publish({ type: 'scheduler.tick', jobKey: 'test' });

  assert.deepEqual(order, ['h1', 'h2', 'h3'],
    'handlers must fire in the order they were subscribed');
});

// ── (b) handler error doesn't block + emits meta event ───────────────────

test('handler error — does not block subsequent handlers and emits event-bus.handler-failed', () => {
  const bus = new EventBus();

  const metaEvents: CortexEvent[] = [];
  bus.subscribe('event-bus.handler-failed', (e) => { metaEvents.push(e); });

  let h2Called = false;
  bus.subscribe('scheduler.tick', () => { throw new Error('boom'); });
  bus.subscribe('scheduler.tick', () => { h2Called = true; });

  bus.publish({ type: 'scheduler.tick', jobKey: 'test' });

  assert.ok(h2Called, 'handler after the failing one must still be called');
  assert.equal(metaEvents.length, 1, 'exactly one event-bus.handler-failed meta event');
  assert.equal(
    (metaEvents[0] as Extract<CortexEvent, { type: 'event-bus.handler-failed' }>).error,
    'boom',
    'meta event must carry the error message',
  );
});

// ── (c) logger backpressure drops oldest ─────────────────────────────────

test('logger backpressure — drops oldest event and emits event-logger.dropped when buffer is full', async () => {
  const logDir = path.join(tmpDir, 'bp-test');
  const bus = new EventBus();

  const droppedEvents: CortexEvent[] = [];
  bus.subscribe('event-logger.dropped', (e) => { droppedEvents.push(e); });

  createEventLogger(bus, { bufferSize: 3, logDir });

  // Publish 4 events to a buffer of size 3: the 4th triggers a drop of the 1st
  bus.publish({ type: 'scheduler.tick', jobKey: 'k1' });
  bus.publish({ type: 'scheduler.tick', jobKey: 'k2' });
  bus.publish({ type: 'scheduler.tick', jobKey: 'k3' });
  bus.publish({ type: 'scheduler.tick', jobKey: 'k4' });

  await bus.close();

  assert.ok(droppedEvents.length >= 1, 'event-logger.dropped must be emitted at least once');

  // Verify k1 was dropped: the written file must not contain "k1"
  const files = await fs.readdir(logDir);
  assert.ok(files.length >= 1, 'at least one log file must have been written');

  const content = await fs.readFile(path.join(logDir, files[0]), 'utf8');
  const lines = content.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const jobKeys = lines.map((e: any) => e.payload?.jobKey).filter(Boolean);

  assert.ok(!jobKeys.includes('k1'), 'k1 (oldest) must have been dropped from the log');
  assert.ok(jobKeys.includes('k4'), 'k4 (newest) must be present in the log');
});

// ── (c2) transient events are not logged ─────────────────────────────────

test('logger skips session.message.delta — a preview is never persisted, and it would dominate the log', async () => {
  const logDir = path.join(tmpDir, 'delta-skip-test');
  const bus = new EventBus();
  createEventLogger(bus, { logDir });

  // A single reply produces dozens of these; the authoritative session.message follows and IS logged.
  for (let i = 0; i < 40; i++) {
    bus.publish({ type: 'session.message.delta', sessionId: 's1', channel: 'web:c', blockId: 'msg_A:1', text: 'chunk', seq: i });
  }
  bus.publish({ type: 'session.message', sessionId: 's1', channel: 'web:c', role: 'assistant', text: 'the whole reply', blockId: 'msg_A:1' });

  await bus.close();

  const files = await fs.readdir(logDir);
  const content = await fs.readFile(path.join(logDir, files[0]), 'utf8');
  const lines = content.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const types = lines.map((e: any) => e.type);

  assert.ok(!types.includes('session.message.delta'), 'deltas must not reach the event log');
  assert.ok(types.includes('session.message'), 'the complete message is still logged');
});

// ── (d) SIGTERM flush writes to disk ─────────────────────────────────────

test('SIGTERM flush — bus.close() drains buffered events to disk', async () => {
  const logDir = path.join(tmpDir, 'flush-test');
  const bus = new EventBus();
  createEventLogger(bus, { logDir });

  // Publish 5 events (well below buffer threshold; flush timer is unref'd so
  // it may not fire in test — bus.close() must flush them explicitly)
  for (let i = 0; i < 5; i++) {
    bus.publish({ type: 'scheduler.tick', jobKey: `job-${i}` });
  }

  await bus.close();

  const files = await fs.readdir(logDir);
  assert.ok(files.length >= 1, 'log file must exist after bus.close()');

  const content = await fs.readFile(path.join(logDir, files[0]), 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 5, 'all 5 events must have been flushed to disk');
});

// ── (e) CORTEX_EVENT_LOG=off disables write ───────────────────────────────

test('CORTEX_EVENT_LOG=off — no log file written when env var is set to off', async () => {
  const logDir = path.join(tmpDir, 'off-test');
  const prev = process.env.CORTEX_EVENT_LOG;
  process.env.CORTEX_EVENT_LOG = 'off';

  try {
    const bus = new EventBus();
    createEventLogger(bus, { logDir });

    bus.publish({ type: 'scheduler.tick', jobKey: 'should-not-be-written' });
    await bus.close();

    // The directory may not even exist; if it does, it must be empty
    let files: string[] = [];
    try { files = await fs.readdir(logDir); } catch { /* directory not created = correct */ }
    assert.equal(files.length, 0, 'no log files must be written when CORTEX_EVENT_LOG=off');
  } finally {
    if (prev === undefined) {
      delete process.env.CORTEX_EVENT_LOG;
    } else {
      process.env.CORTEX_EVENT_LOG = prev;
    }
  }
});
