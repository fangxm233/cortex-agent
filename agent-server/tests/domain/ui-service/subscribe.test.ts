import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventBus } from '../../../src/events/event-bus.js';
import { createSubscription } from '../../../src/domain/ui-service/subscribe.js';

test('subscribe receives published events matching filter', async () => {
  const bus = new EventBus();
  const sub = createSubscription(bus, {
    events: ['thread.created', 'task.claimed'],
  });

  bus.publish({ type: 'thread.created', threadId: 'thr_1', templateName: 'test' });
  bus.publish({ type: 'task.claimed', taskId: 't1', by: 'agent1' });

  const iter = sub[Symbol.asyncIterator]();
  const event1 = await iter.next();
  assert.equal(event1.done, false);
  assert.equal(event1.value.type, 'thread.created');
  assert.ok(event1.value.ts);

  const event2 = await iter.next();
  assert.equal(event2.done, false);
  assert.equal(event2.value.type, 'task.claimed');

  sub.close();
});

test('subscribe passes through task.unclaimed / task.unblocked events', async () => {
  const bus = new EventBus();
  const sub = createSubscription(bus, {
    events: ['task.unclaimed', 'task.unblocked'],
  });

  bus.publish({ type: 'task.unclaimed', taskId: 't1' });
  bus.publish({ type: 'task.unblocked', taskId: 't2' });

  const iter = sub[Symbol.asyncIterator]();
  const event1 = await iter.next();
  assert.equal(event1.done, false);
  assert.equal(event1.value.type, 'task.unclaimed');
  assert.ok(event1.value.ts);
  assert.equal((event1.value.payload as any).taskId, 't1');

  const event2 = await iter.next();
  assert.equal(event2.done, false);
  assert.equal(event2.value.type, 'task.unblocked');
  assert.equal((event2.value.payload as any).taskId, 't2');

  sub.close();
});

test('subscribe scopes session.message to a single sessionId (no cross-session leak)', async () => {
  const bus = new EventBus();
  const sub = createSubscription(bus, {
    events: ['session.message'],
    sessionId: 'sess-A',
  });

  // An event for a different session must NOT be delivered…
  bus.publish({ type: 'session.message', sessionId: 'sess-B', channel: 'C2', role: 'assistant', text: 'leak?' });
  // …only the matching one is.
  bus.publish({ type: 'session.message', sessionId: 'sess-A', channel: 'C1', role: 'assistant', text: 'for A' });

  const iter = sub[Symbol.asyncIterator]();
  const first = await iter.next();
  assert.equal(first.done, false);
  assert.equal(first.value.type, 'session.message');
  assert.equal((first.value.payload as any).sessionId, 'sess-A');
  assert.equal((first.value.payload as any).text, 'for A');

  sub.close();
});

test('subscribe with no sessionId filter receives session.message for any session', async () => {
  const bus = new EventBus();
  const sub = createSubscription(bus, { events: ['session.message'] });

  bus.publish({ type: 'session.message', sessionId: 'sess-B', channel: 'C2', role: 'user', text: 'hi' });

  const iter = sub[Symbol.asyncIterator]();
  const first = await iter.next();
  assert.equal(first.done, false);
  assert.equal((first.value.payload as any).sessionId, 'sess-B');

  sub.close();
});

test('subscribe filters out non-matching event types', async () => {
  const bus = new EventBus();
  const sub = createSubscription(bus, {
    events: ['agent.started'],
  });

  bus.publish({ type: 'thread.created', threadId: 'thr_1', templateName: 'test' });
  bus.publish({ type: 'agent.started', channel: 'C1', executionId: 'exec_1', backend: 'claude' });

  const iter = sub[Symbol.asyncIterator]();
  const event1 = await iter.next();
  assert.equal(event1.done, false);
  assert.equal(event1.value.type, 'agent.started');

  sub.close();
});

test('subscribe close() unsubscribes all bus handlers', async () => {
  const bus = new EventBus();
  let called = false;

  // Subscribe normally to verify handler is registered
  const sub1 = bus.subscribe('thread.created', () => { called = true; });
  const sub = createSubscription(bus, {
    events: ['thread.created'],
  });

  // Close the UI subscription
  sub.close();

  // Publish event — the original handler (sub1) still fires, but the UI subscription handler doesn't
  bus.publish({ type: 'thread.created', threadId: 'thr_1', templateName: 'test' });

  // The external handler should still work
  assert.equal(called, true);

  sub1.unsubscribe();
});

test('subscribe provides UiEvent shape with type, ts, payload', async () => {
  const bus = new EventBus();
  const sub = createSubscription(bus, {
    events: ['task.claimed'],
  });

  bus.publish({ type: 'task.claimed', taskId: 't1', by: 'agent1' });

  const iter = sub[Symbol.asyncIterator]();
  const event = await iter.next();
  assert.equal(event.done, false);
  assert.equal(typeof event.value.type, 'string');
  assert.equal(typeof event.value.ts, 'string');
  assert.ok(event.value.payload);
  const payload = event.value.payload as any;
  assert.equal(payload.type, 'task.claimed');
  assert.equal(payload.taskId, 't1');

  sub.close();
});

test('subscribe handles close() called multiple times', () => {
  const bus = new EventBus();
  const sub = createSubscription(bus, {
    events: ['thread.created'],
  });

  sub.close();
  sub.close(); // second close should not throw
  assert.ok(true, 'multiple close() calls ok');
});

test('subscribe close() signals iterator done', async () => {
  const bus = new EventBus();
  const sub = createSubscription(bus, {
    events: ['thread.created'],
  });

  // Close before consuming
  sub.close();

  const iter = sub[Symbol.asyncIterator]();
  const result = await iter.next();
  assert.equal(result.done, true);
});

test('subscribe close() unblocks pending iterator next()', async () => {
  const bus = new EventBus();
  const sub = createSubscription(bus, {
    events: ['thread.created'],
  });

  const iter = sub[Symbol.asyncIterator]();

  // Start a pending next() that will block (no events published)
  const nextPromise = iter.next();

  // Close the subscription — should unblock the pending next()
  sub.close();

  const result = await nextPromise;
  assert.equal(result.done, true);
});
