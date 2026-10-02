import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../src/events/event-bus.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import type { UiService, UiServiceDeps } from '../../../src/domain/ui-service/types.js';

let bus: EventBus;
let service: UiService;
const delta = (sessionId = 'A', text = 'prefix', seq = 0, blockId = 'b1') =>
  bus.publish({ type: 'session.message.delta', sessionId, channel: 'web:c', blockId, text, seq });
const open = (sessionId = 'A') => service.subscribe({ sessionId, events: ['session.message.delta'] });
async function snapshot(sessionId = 'A') {
  const sub = open(sessionId);
  sub.close(); // A missing seed returns done, rather than hanging the test.
  return (await sub[Symbol.asyncIterator]().next()).value?.payload;
}
const empty = { sessionId: 'A', snapshot: true, text: '' };

beforeEach(() => {
  bus = new EventBus();
  service = createUiService({ bus } as UiServiceDeps);
});
afterEach(async () => { await bus.close(); });

describe('UI service active assistant snapshots', () => {
  it('caches without subscribers, seeds synchronously, then sends only increments', async () => {
    delta('A', 'pre');
    delta('A', 'fix', 1);
    const sub = open();
    delta('A', ' suffix', 2); // Published before the consumer starts iterating.
    sub.close();
    const events = [];
    for await (const event of sub) events.push(event);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'session.message.delta', payload: {
      sessionId: 'A', blockId: 'b1', text: 'prefix', seq: 1, snapshot: true,
    } });
    expect(events[1].payload).toMatchObject({ text: ' suffix', seq: 2 });
    expect(events[1].payload).not.toHaveProperty('snapshot');
    expect(await snapshot()).toMatchObject({ text: 'prefix suffix', seq: 2 });
  });

  it('isolates sessions and does not seed unscoped or non-delta subscriptions', async () => {
    delta();
    delta('B', 'other');
    expect(await snapshot('B')).toMatchObject({ sessionId: 'B', text: 'other' });
    expect(await snapshot('C')).toMatchObject({ sessionId: 'C', snapshot: true, text: '' });
    for (const filter of [{ events: ['session.message.delta'] }, { sessionId: 'A', events: ['session.message'] }]) {
      const sub = service.subscribe(filter);
      sub.close();
      expect((await sub[Symbol.asyncIterator]().next()).done).toBe(true);
    }
    expect(await snapshot()).toMatchObject({ text: 'prefix' });
  });

  it('replaces on a new block and ignores duplicate/old sequence numbers within a block', async () => {
    delta();
    delta('A', ' suffix', 1);
    delta('A', 'duplicate', 1);
    delta('A', 'old', 0);
    expect(await snapshot()).toMatchObject({ text: 'prefix suffix', seq: 1 });
    delta('A', 'new block', 0, 'b2');
    expect(await snapshot()).toMatchObject({ text: 'new block', blockId: 'b2', seq: 0 });
  });

  it.each([
    { role: 'assistant' as const, blockId: 'b1' },
    { role: 'assistant' as const }, // Non-streaming backend fallback.
  ])('clears on normal main completion %j', async (message) => {
    delta();
    delta('B', 'other');
    bus.publish({ type: 'session.message', sessionId: 'A', channel: 'web:c', text: 'whole', ...message });
    expect(await snapshot()).toMatchObject(empty);
    expect(await snapshot('B')).toMatchObject({ text: 'other' });
  });

  it.each([
    { role: 'assistant' as const, blockId: 'b1', noticeLevel: 'info' as const },
    { role: 'assistant' as const, blockId: 'b1', subagentId: 'child' },
    { role: 'assistant' as const, blockId: 'different' },
    { role: 'user' as const },
    { role: 'tool' as const },
  ])('keeps the main preview for unrelated messages %j', async (message) => {
    delta();
    bus.publish({ type: 'session.message', sessionId: 'A', channel: 'web:c', text: 'unrelated', ...message });
    expect(await snapshot()).toMatchObject({ text: 'prefix', blockId: 'b1' });
  });

  it('clears on status false and rewind, not status true or other sessions', async () => {
    delta();
    bus.publish({ type: 'session.status', sessionId: 'A', channel: 'web:c', running: true });
    bus.publish({ type: 'session.status', sessionId: 'B', channel: 'web:c', running: false });
    expect(await snapshot()).toMatchObject({ text: 'prefix' });
    bus.publish({ type: 'session.status', sessionId: 'A', channel: 'web:c', running: false });
    expect(await snapshot()).toMatchObject(empty);
    delta();
    bus.publish({ type: 'session.rewound', sessionId: 'A', channel: 'web:c', turnIndex: 0 });
    expect(await snapshot()).toMatchObject(empty);
  });

  it('removes cache listeners and cached text at bus.close', async () => {
    const ownedBus = new EventBus();
    const subscribe = ownedBus.subscribe.bind(ownedBus);
    const unsubs: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(ownedBus, 'subscribe').mockImplementation(((type: any, handler: any) => {
      const sub = subscribe(type, handler);
      const unsubscribe = vi.fn(() => sub.unsubscribe());
      unsubs.push(unsubscribe);
      return { unsubscribe };
    }) as typeof ownedBus.subscribe);
    service = createUiService({ bus: ownedBus } as UiServiceDeps);
    bus = ownedBus;
    delta();
    expect(unsubs).toHaveLength(4);
    await bus.close();
    expect(unsubs.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true);
    delta('A', 'after close', 1);
    expect(await snapshot()).toMatchObject(empty);
  });
});
