// input:  EventBus + SubscribeFilter
// output: AsyncIterable<UiEvent> & { close() } — bounded queue, overflow emits synthetic dropped event
// pos:    subscribe primitive for UiService

import type { EventBus } from '@events/index.js';
import type { SubscribeFilter, UiEvent } from './types.js';

const QUEUE_CAP = 256;

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

export function createSubscription(
  bus: EventBus,
  filter: SubscribeFilter,
): AsyncIterable<UiEvent> & { close(): void } {
  const eventTypes = filter.events;
  const projectId = filter.projectId ?? null;
  const executionId = filter.executionId ?? null;
  const sessionId = filter.sessionId ?? null;
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

  const subscriptions = eventTypes.map((type) => {
    const sub = bus.subscribe(type as any, (event: any) => {
      // Post-filter by projectId if specified
      if (projectId && event.projectId && event.projectId !== projectId) {
        return;
      }
      if (projectId && event.payload?.projectId && event.payload.projectId !== projectId) {
        return;
      }

      // Post-filter by executionId — scopes execution.log to a single execution (B2-C).
      if (executionId && event.executionId && event.executionId !== executionId) {
        return;
      }

      // Post-filter by sessionId — scopes session.message to a single session (S4 chat).
      if (sessionId && event.sessionId && event.sessionId !== sessionId) {
        return;
      }

      const uiEvent: UiEvent = {
        type: event.type,
        ts: event.ts,
        payload: event,
      };
      queue.push(uiEvent);
    });
    return sub;
  });

  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const sub of subscriptions) {
      sub.unsubscribe();
    }
    queue.close();
  };

  return {
    [Symbol.asyncIterator](): AsyncIterator<UiEvent> {
      return queue[Symbol.asyncIterator]();
    },
    close,
  };
}
