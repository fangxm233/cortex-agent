import { createLogger } from '@core/log.js';
import { waitpointRepo, type Waitpoint } from '@store/waitpoint-repo.js';
import { buildExpiryNotice, buildSignalNotice } from '@domain/waitpoints/notices.js';
import { deliverToSession, type DeliverToSessionOptions } from './session-gateway.js';

const log = createLogger('waitpoint-notifier');

export interface WaitpointNotifierDeps {
  repo: Pick<typeof waitpointRepo, 'get' | 'list' | 'update'>;
  /** Resolves once the wake turn is admitted; throws when it was not, so the wake stays pending. */
  deliver: (channel: string, text: string, tag: string) => Promise<void>;
  now: () => number;
}

/**
 * Open the wake turn. A supervisor rebuild refuses new turns, and without `onRebuildHold` the
 * runner would answer that with a "dropped" notice and return normally — the wake would then be
 * stamped delivered and never retried. Throwing instead puts `delivery.pending` back, and the sweep
 * delivers it once the hold lifts (or after the restart, from disk).
 */
export async function deliverWakeTurn(
  channel: string,
  text: string,
  tag: string,
  gateway: (opts: DeliverToSessionOptions) => Promise<void> = deliverToSession,
): Promise<void> {
  let held = false;
  await gateway({ channel, text, origin: 'external-signal', tag, onRebuildHold: () => { held = true; } });
  if (held) throw new Error('refused by a supervisor rebuild; retrying once it is over');
}

export const productionNotifierDeps: WaitpointNotifierDeps = {
  repo: waitpointRepo,
  deliver: (channel, text, tag) => deliverWakeTurn(channel, text, tag),
  now: () => Date.now(),
};

/** Coalesce timers, keyed by waitpoint id. In-memory only — a lost timer is recovered by the sweep. */
const pendingTimers = new Map<string, NodeJS.Timeout>();

/**
 * Deliver one waitpoint's pending wake, if it still has one.
 *
 * Clears `delivery.pending` *before* sending: a duplicate wake is a wasted turn, while a dropped
 * one is a silently lost notification, so the bit is restored on failure and the sweep retries.
 */
async function deliverOne(id: string, deps: WaitpointNotifierDeps): Promise<boolean> {
  const claimed = await deps.repo.update<Waitpoint | null>(id, (wp) => {
    if (!wp.delivery.pending) return { next: wp, result: null };
    wp.delivery.pending = false;
    wp.delivery.attempts += 1;
    wp.delivery.lastAt = deps.now();
    return { next: wp, result: wp };
  });
  const wp = claimed ?? null;
  if (!wp) return false;

  const now = deps.now();
  // Signals are append-only, so the ones this notice reports are exactly the first `reported`.
  const reported = wp.signals.length;
  const fresh = wp.signals.filter((s) => !s.deliveredAt);
  const text = wp.state === 'expired'
    ? buildExpiryNotice(wp, now, fresh)
    : buildSignalNotice(wp, {
      signals: fresh.length > 0 ? fresh : wp.signals.slice(-1),
      now,
      heldByCap: wp.delivery.heldByCap === true,
    });

  try {
    await deps.deliver(wp.owner.channel, text, wp.id);
    await deps.repo.update(id, (current) => {
      for (const signal of current.signals.slice(0, reported)) signal.deliveredAt = signal.deliveredAt ?? now;
      current.delivery.lastError = null;
      current.delivery.heldByCap = false;
      return { next: current, result: undefined };
    });
    log.info(`delivered ${wp.id} to ${wp.owner.channel}`);
    return true;
  } catch (error) {
    const message = (error as Error).message;
    await deps.repo.update(id, (current) => {
      current.delivery.pending = true;
      current.delivery.lastError = message;
      return { next: current, result: undefined };
    });
    log.error(`deliver ${wp.id} failed, will retry: ${message}`);
    return false;
  }
}

/**
 * Arrange for a fired waitpoint to be delivered: immediately, or after its coalesce window so a
 * burst of sibling signals (eight arms finishing at once) becomes one turn instead of eight.
 */
export function scheduleWaitpointDelivery(
  wp: Waitpoint,
  deps: WaitpointNotifierDeps = productionNotifierDeps,
): void {
  if (wp.coalesceMs <= 0) {
    void deliverOne(wp.id, deps).catch((e) => log.error(`deliver ${wp.id}: ${(e as Error).message}`));
    return;
  }
  if (pendingTimers.has(wp.id)) return;
  const timer = setTimeout(() => {
    pendingTimers.delete(wp.id);
    void deliverOne(wp.id, deps).catch((e) => log.error(`deliver ${wp.id}: ${(e as Error).message}`));
  }, wp.coalesceMs);
  timer.unref?.();
  pendingTimers.set(wp.id, timer);
}

/**
 * Drain every waitpoint carrying an undelivered wake. Used at boot (a restart drops the in-memory
 * coalesce timers) and on each sweep tick (retry after a delivery failure). Returns the count sent.
 */
export async function deliverPendingWaitpoints(
  deps: WaitpointNotifierDeps = productionNotifierDeps,
): Promise<number> {
  const all = await deps.repo.list();
  let delivered = 0;
  for (const wp of all) {
    if (!wp.delivery.pending) continue;
    if (await deliverOne(wp.id, deps)) delivered += 1;
  }
  return delivered;
}

/** Mark freshly expired waitpoints for delivery so their owner learns nobody ever signalled. */
export async function notifyWaitpointExpiry(
  expired: Waitpoint[],
  deps: WaitpointNotifierDeps = productionNotifierDeps,
): Promise<void> {
  for (const wp of expired) {
    await deps.repo.update(wp.id, (current) => {
      current.delivery.pending = true;
      return { next: current, result: undefined };
    });
    await deliverOne(wp.id, deps).catch((e) => log.error(`expiry notice ${wp.id}: ${(e as Error).message}`));
  }
}

/** Test hook: drop any armed coalesce timers. */
export function resetWaitpointTimers(): void {
  for (const timer of pendingTimers.values()) clearTimeout(timer);
  pendingTimers.clear();
}
