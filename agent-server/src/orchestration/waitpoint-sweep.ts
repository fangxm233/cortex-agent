// input:  settings (waitpointSweepMs), waitpoint service, notifier, ingress
// output: sweepWaitpoints / startWaitpointSweep / stopWaitpointSweep / recoverWaitpoints
// pos:    The disk-driven backstop for waitpoints. Every fast path (the coalesce timer, the HTTP
//         route) is in-memory and dies with the process; this loop re-derives everything from
//         waitpoints.json and the spool directory, so a signal that arrived while the daemon was
//         restarting is still delivered, just later.
//
//         Deliberately self-rearming setTimeout rather than setInterval: a slow sweep must not
//         stack, and the cadence is re-read each tick so a settings change takes effect next round.

import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { expireDueWaitpoints, productionWaitpointDeps, type WaitpointServiceDeps } from '@domain/waitpoints/service.js';
import {
  deliverPendingWaitpoints,
  notifyWaitpointExpiry,
  productionNotifierDeps,
  type WaitpointNotifierDeps,
} from './waitpoint-notifier.js';
import { drainLocalSpool, productionIngestDeps, type IngestDeps } from './waitpoint-ingress.js';

const log = createLogger('waitpoint-sweep');

export interface WaitpointSweepDeps {
  service: WaitpointServiceDeps;
  notifier: WaitpointNotifierDeps;
  ingest: IngestDeps;
  now: () => number;
  /** Override the drained spool directory. Production leaves it unset (the default location). */
  spoolDir?: string;
}

export const productionSweepDeps: WaitpointSweepDeps = {
  service: productionWaitpointDeps,
  notifier: productionNotifierDeps,
  ingest: productionIngestDeps,
  now: () => Date.now(),
};

export interface SweepResult {
  spooled: number;
  expired: number;
  delivered: number;
  purged: number;
}

/**
 * One pass: take in whatever the outside world left on disk, age out what is past due, then flush
 * every undelivered wake. Order matters — draining first means a signal that landed a second before
 * the deadline still beats the expiry notice.
 */
export async function sweepWaitpoints(deps: WaitpointSweepDeps = productionSweepDeps): Promise<SweepResult> {
  const spooled = await (deps.spoolDir
    ? drainLocalSpool(deps.ingest, deps.spoolDir)
    : drainLocalSpool(deps.ingest)
  ).catch((e) => {
    log.error(`spool drain: ${(e as Error).message}`);
    return 0;
  });
  const { expired, purged } = await expireDueWaitpoints(deps.service);
  if (expired.length > 0) await notifyWaitpointExpiry(expired, deps.notifier);
  const delivered = await deliverPendingWaitpoints(deps.notifier);
  return { spooled, expired: expired.length, delivered, purged };
}

let timer: NodeJS.Timeout | null = null;

function arm(intervalMs: number): void {
  timer = setTimeout(async () => {
    timer = null;
    await sweepWaitpoints().catch((e) => log.error(`sweep: ${(e as Error).message}`));
    const next = getSettings().waitpointSweepMs;
    // Runtime zero stops re-arming until restart; startup zero never starts the loop.
    if (next > 0) arm(next);
  }, intervalMs);
  timer.unref?.();
}

/** Start the periodic waitpoint sweep. No-op when the configured interval is disabled. */
export function startWaitpointSweep(): void {
  const intervalMs = getSettings().waitpointSweepMs;
  if (intervalMs <= 0) return;
  arm(intervalMs);
}

/**
 * Stop the loop. Must run before the repos are flushed on shutdown: a timer firing after
 * waitpointRepo.flush() resolves would enqueue a mutate() whose write is then lost.
 */
export function stopWaitpointSweep(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * Boot reconciliation. A restart drops every in-memory coalesce timer, so a waitpoint that fired
 * moments before shutdown has `delivery.pending` set and nobody scheduled to send it; the spool may
 * also hold signals written while the daemon was down. Returns what it recovered, and never throws
 * — a recovery failure must not block startup.
 */
export async function recoverWaitpoints(deps: WaitpointSweepDeps = productionSweepDeps): Promise<SweepResult> {
  return sweepWaitpoints(deps).catch((e) => {
    log.error(`recovery failed: ${(e as Error).message}`);
    return { spooled: 0, expired: 0, delivered: 0, purged: 0 };
  });
}
