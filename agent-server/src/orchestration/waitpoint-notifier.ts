// input:  waitpoint repo records with delivery.pending set, session-gateway
// output: deliverPendingWaitpoints / scheduleWaitpointDelivery / notifyWaitpointExpiry
// pos:    Turns a fired waitpoint into a wake turn. Lives in orchestration/ because it reaches
//         session-gateway; the firing decision itself is domain/waitpoints/service.ts.
//         Delivery is disk-driven: applySignal only sets `delivery.pending`, and every path here
//         (immediate, coalesced, boot replay, sweep retry) drains that same bit, so a crash between
//         firing and delivering costs at most one replay rather than the notice.

import { createLogger } from '@core/log.js';
import { waitpointRepo, type Waitpoint } from '@store/waitpoint-repo.js';
import { buildExpiryNotice, buildSignalNotice } from '@domain/waitpoints/notices.js';
import { deliverToSession } from './session-gateway.js';

const log = createLogger('waitpoint-notifier');

export interface WaitpointNotifierDeps {
  repo: Pick<typeof waitpointRepo, 'get' | 'list' | 'update'>;
  deliver: (channel: string, text: string, tag: string) => Promise<void>;
  now: () => number;
}

export const productionNotifierDeps: WaitpointNotifierDeps = {
  repo: waitpointRepo,
  deliver: async (channel, text, tag) => {
    await deliverToSession({ channel, text, origin: 'external-signal', tag });
  },
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
  const text = wp.state === 'expired'
    ? buildExpiryNotice(wp, now)
    : buildSignalNotice(wp, { signals: undeliveredSignals(wp), now, rateLimited: wp.rateLimitNotified === true });

  try {
    await deps.deliver(wp.owner.channel, text, wp.id);
    await deps.repo.update(id, (current) => {
      for (const signal of current.signals) signal.deliveredAt = signal.deliveredAt ?? now;
      current.delivery.lastError = null;
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

/** Signals not yet folded into a previous wake — what this notice is actually reporting. */
function undeliveredSignals(wp: Waitpoint): Waitpoint['signals'] {
  const fresh = wp.signals.filter((s) => !s.deliveredAt);
  return fresh.length > 0 ? fresh : wp.signals.slice(-1);
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
