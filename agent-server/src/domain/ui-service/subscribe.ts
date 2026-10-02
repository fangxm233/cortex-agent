import type { EventBus } from '@events/index.js';
import type { AssistantSnapshots } from './assistant-snapshots.js';
import type { SubscribeFilter, UiEvent } from './types.js';

const QUEUE_CAP = 256;

/**
 * Event types that a subscription only receives when it names the session they belong to.
 *
 * `session.message.delta` is a token-level preview: dozens per reply, and useful to exactly one
 * client — the one rendering that session's chat. Letting an unscoped subscription (the app's
 * shared live stream carries every session) take them would fill the 256-slot queue with another
 * session's previews and drop-oldest away the status / thread / task events it exists to deliver.
 * So the scope is required rather than optional: no `sessionId` filter, no deltas.
 */
const SESSION_SCOPED_ONLY = new Set<string>(['session.message.delta']);

interface AsyncQueue<T> {
  push(item: T): void;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

/**
 * Create an async queue with bounded capacity. When `onOverflow` is set, it
 * is called from within a re-entrant guard so that push() calls from the
 * callback do not recursively trigger overflow — guaranteeing that exactly
 * one oldest item is dropped per real overflow.
 */
function createAsyncQueue<T>(
  cap: number,
  onOverflow?: () => void,
): AsyncQueue<T> {
  const buffer: T[] = [];
  let resolve: ((value: IteratorResult<T>) => void) | null = null;
  let _closed = false;
  let _inOverflow = false;

  return {
    push(item: T): void {
      if (_closed) return;
      if (!_inOverflow && buffer.length >= cap) {
        buffer.shift();
        if (onOverflow) {
          _inOverflow = true;
          try { onOverflow(); } finally { _inOverflow = false; }
        }
      }
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: item, done: false });
      } else {
        buffer.push(item);
      }
    },
    close(): void {
      _closed = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined as any, done: true });
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: (): Promise<IteratorResult<T>> => {
          if (buffer.length > 0) {
            const value = buffer.shift()!;
            return Promise.resolve({ value, done: false });
          }
          if (_closed) {
            return Promise.resolve({ value: undefined as any, done: true });
          }
          return new Promise((res) => {
            resolve = res;
          });
        },
      };
    },
  };
}

function createUiQueue(): AsyncQueue<UiEvent> {
  let droppedCount = 0;

  // Wire overflow handler: push a synthetic UiEvent onto the queue.
  // The queue's _inOverflow guard ensures push() from this callback does
  // NOT re-trigger overflow, so the synthetic always lands safely.
  const queue = createAsyncQueue<UiEvent>(QUEUE_CAP, () => {
    droppedCount++;
    const synthetic: UiEvent = {
      type: 'ui-subscribe.dropped',
      ts: new Date().toISOString(),
      payload: { droppedCount },
    };
    // push() from within the guard: no overflow shift, item always appended.
    queue.push(synthetic);
  });

  return queue;
}

function matchesScope(event: any, { projectId, sessionId }: SubscribeFilter): boolean {
  // Scope-required types must be filtered BEFORE reaching the bounded queue.
  if (SESSION_SCOPED_ONLY.has(event.type) && (!sessionId || event.sessionId !== sessionId)) return false;
  if (projectId && (
    (event.projectId && event.projectId !== projectId)
    || (event.payload?.projectId && event.payload.projectId !== projectId)
  )) return false;
  return !(sessionId && event.sessionId && event.sessionId !== sessionId);
}

export function createSubscription(
  bus: EventBus,
  filter: SubscribeFilter,
  assistantSnapshots?: AssistantSnapshots,
): AsyncIterable<UiEvent> & { close(): void } {
  const queue = createUiQueue();
  const subscriptions = filter.events.map((type) => bus.subscribe(type as any, (event: any) => {
    if (matchesScope(event, filter)) queue.push({ type: event.type, ts: event.ts, payload: event });
  }));
  // Registration and seed enqueue are synchronous: no publish can fall between the snapshot
  // and forwarding. Seeds are never published onto the bus or sent to unscoped subscribers.
  if (filter.sessionId && filter.events.includes('session.message.delta') && assistantSnapshots) {
    queue.push(assistantSnapshots.snapshot(filter.sessionId));
  }
  let closed = false;
  return {
    [Symbol.asyncIterator](): AsyncIterator<UiEvent> {
      return queue[Symbol.asyncIterator]();
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const sub of subscriptions) sub.unsubscribe();
      queue.close();
    },
  };
}
