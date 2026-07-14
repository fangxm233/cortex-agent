// input:  CortexEvent (event-types.ts)
// output: EventBus class — subscribe / publish / close
// pos:    events/ layer, only depends on event-types
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createLogger } from '@core/log.js';
import type { CortexEvent, CortexEventInput } from './event-types.js';

const log = createLogger('event-bus');

export interface Subscription {
  unsubscribe(): void;
}

type AnyHandler = (e: CortexEvent) => void | Promise<void>;

interface HandlerEntry {
  matchType: string;  // event type string or '*'
  handler: AnyHandler;
}

export class EventBus {
  private _entries: HandlerEntry[] = [];
  private _closeHooks: Array<() => Promise<void>> = [];
  /** Guard against re-entrant event-bus.handler-failed loops. */
  private _inHandlerFailed = false;

  /**
   * Subscribe to a specific event type or '*' for all events.
   * Handlers are called in subscription-registration order on publish.
   *
   * Overloads narrow `e` to the matching variant when a specific K is given;
   * the '*' form receives the full CortexEvent union.
   */
  subscribe<K extends CortexEvent['type']>(
    type: K,
    handler: (e: Extract<CortexEvent, { type: K }>) => void | Promise<void>,
  ): Subscription;
  subscribe(
    type: '*',
    handler: (e: CortexEvent) => void | Promise<void>,
  ): Subscription;
  subscribe(type: string, handler: AnyHandler): Subscription {
    const entry: HandlerEntry = { matchType: type, handler };
    this._entries.push(entry);
    return {
      unsubscribe: () => {
        const idx = this._entries.indexOf(entry);
        if (idx !== -1) this._entries.splice(idx, 1);
      },
    };
  }

  /**
   * Publish an event.  `ts` defaults to `new Date().toISOString()` when the caller
   * omits it; a caller-provided `ts` is preserved (allows two subsystems to share
   * a single timestamp for the same logical moment — e.g. conversation-history +
   * session.message event used for client-side de-dup).
   *
   * Fan-out is synchronous: all matching handlers are called in subscription order
   * before publish() returns.  If a handler returns a Promise it is fire-and-forget
   * (errors are caught and logged).  If a handler throws synchronously the error is
   * logged and an `event-bus.handler-failed` meta-event is published; the remaining
   * handlers continue to run.
   */
  publish(e: CortexEventInput & { ts?: string }): void {
    const event = { ts: new Date().toISOString(), ...e } as CortexEvent;

    // Snapshot to avoid mutation during iteration (unsubscribe inside a handler is safe)
    const entries = this._entries.slice();

    for (const entry of entries) {
      if (entry.matchType !== '*' && entry.matchType !== event.type) continue;

      let result: void | Promise<void>;
      try {
        result = entry.handler(event);
      } catch (err) {
        log.error(`handler for "${entry.matchType}" threw:`, err);
        this._emitHandlerFailed(entry.matchType, err);
        continue;
      }

      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch((err) => {
          log.error(`async handler for "${entry.matchType}" rejected:`, err);
        });
      }
    }
  }

  private _emitHandlerFailed(handlerType: string, err: unknown): void {
    if (this._inHandlerFailed) return; // prevent re-entrant loops
    this._inHandlerFailed = true;
    try {
      this.publish({
        type: 'event-bus.handler-failed',
        handlerType,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this._inHandlerFailed = false;
    }
  }

  /**
   * Register a hook called by close().  EventLogger uses this to flush its buffer
   * before the process exits on SIGTERM.
   */
  registerCloseHook(fn: () => Promise<void>): void {
    this._closeHooks.push(fn);
  }

  /**
   * Flush all registered close hooks (e.g., EventLogger buffer drain).
   * Called from the app.ts SIGTERM handler alongside repo flushes.
   */
  async close(): Promise<void> {
    await Promise.allSettled(this._closeHooks.map((fn) => fn()));
  }
}
