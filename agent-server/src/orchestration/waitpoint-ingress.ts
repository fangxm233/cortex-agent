// input:  signal payloads (HTTP route, local spool files), waitpoint service
// output: ingestSignal / drainLocalSpool / recentSignalRejections / SIGNAL_SPOOL_DIR
// pos:    The single door every external signal walks through, whatever carried it. Applies the
//         signal to its waitpoint and, when that fires, hands it to the notifier. Lives in
//         orchestration/ because it reaches the notifier; the state machine stays in domain/.
//
//         Two properties this layer owns and the service does not:
//         - anti-enumeration: unknown ids and bad secrets are rate-limited globally and recorded
//           in a bounded dead-letter ring, so a typo in a training script is debuggable and a
//           scan for live waitpoints is not free.
//         - spool ingestion: a file dropped in the spool dir is equivalent to a POST, which is how
//           a machine with no curl (or no route to the daemon) still reports.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@core/log.js';
import { WORKSPACE_DIR } from '@core/paths.js';
import {
  applySignal,
  productionWaitpointDeps,
  type ApplySignalOutcome,
  type SignalInput,
  type WaitpointServiceDeps,
} from '@domain/waitpoints/service.js';
import {
  productionNotifierDeps,
  scheduleWaitpointDelivery,
  type WaitpointNotifierDeps,
} from './waitpoint-notifier.js';

const log = createLogger('waitpoint-ingress');

/** Any process that can write a file can signal: drop `<anything>.json` here. */
export const SIGNAL_SPOOL_DIR = path.join(WORKSPACE_DIR, 'signals');
/** Files that could never be applied (unparseable, unknown id) are parked here, not deleted. */
export const SIGNAL_SPOOL_BAD_DIR = path.join(SIGNAL_SPOOL_DIR, 'bad');

/** A spool entry larger than this is refused outright — signals are summaries, not logs. */
export const SPOOL_FILE_MAX_BYTES = 64 * 1024;

// --- dead letter + anti-enumeration ---

export interface SignalRejection {
  at: number;
  reason: 'not-found' | 'bad-secret' | 'rate-limited';
  id: string;
  source: string;
}

const REJECTION_RING_MAX = 50;
const rejections: SignalRejection[] = [];

/** Failed lookups allowed per minute across all callers, before every miss is refused unread. */
const MISS_BUDGET_PER_MINUTE = 60;
let missWindowStart = 0;
let missCount = 0;

function recordRejection(reason: SignalRejection['reason'], id: string, source: string, now: number): void {
  rejections.push({ at: now, reason, id, source });
  if (rejections.length > REJECTION_RING_MAX) rejections.shift();
  log.warn(`signal rejected (${reason}) for ${id || '(no id)'} from ${source}`);
}

/** Recent rejected signals, newest last. Diagnostic surface for "my script says 404". */
export function recentSignalRejections(): SignalRejection[] {
  return [...rejections];
}

/** Test hook. */
export function resetSignalIngressState(): void {
  rejections.length = 0;
  missWindowStart = 0;
  missCount = 0;
}

function overMissBudget(now: number): boolean {
  if (now - missWindowStart > 60_000) {
    missWindowStart = now;
    missCount = 0;
  }
  missCount += 1;
  return missCount > MISS_BUDGET_PER_MINUTE;
}

// --- ingest ---

export interface IngestDeps {
  service: WaitpointServiceDeps;
  notifier: WaitpointNotifierDeps;
  now: () => number;
}

export const productionIngestDeps: IngestDeps = {
  service: productionWaitpointDeps,
  notifier: productionNotifierDeps,
  now: () => Date.now(),
};

/**
 * Apply one signal and schedule the wake it earned.
 *
 * Returns the raw outcome; mapping it onto HTTP status codes is the route's job, because the spool
 * path has no status codes to map onto.
 */
export async function ingestSignal(
  input: SignalInput,
  deps: IngestDeps = productionIngestDeps,
): Promise<ApplySignalOutcome> {
  const now = deps.now();
  if (!input.id || typeof input.id !== 'string') {
    recordRejection('not-found', String(input.id ?? ''), input.source, now);
    return { kind: 'not-found' };
  }

  const outcome = await applySignal(input, deps.service);

  if (outcome.kind === 'not-found' || outcome.kind === 'bad-secret') {
    if (overMissBudget(now)) {
      recordRejection('rate-limited', input.id, input.source, now);
      return { kind: 'rate-limited' };
    }
    recordRejection(outcome.kind, input.id, input.source, now);
    return outcome;
  }

  if (outcome.kind === 'accepted' && outcome.fired) {
    scheduleWaitpointDelivery(outcome.waitpoint, deps.notifier);
  }
  return outcome;
}

// --- local spool ---

interface SpoolEntry {
  file: string;
  payload: Record<string, unknown>;
}

async function readSpoolDir(dir: string, badDir: string): Promise<SpoolEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const entries: SpoolEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      if (stat.size > SPOOL_FILE_MAX_BYTES) {
        await quarantine(full, name, badDir);
        continue;
      }
      const parsed = JSON.parse(await fs.readFile(full, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) {
        await quarantine(full, name, badDir);
        continue;
      }
      entries.push({ file: name, payload: parsed as Record<string, unknown> });
    } catch {
      // A half-written file is normal: writers are told to write `.tmp` then rename, but a
      // truncated or malformed one must not stall the whole batch. Park it and move on.
      await quarantine(full, name, badDir);
    }
  }
  return entries;
}

async function quarantine(fullPath: string, name: string, badDir: string): Promise<void> {
  try {
    await fs.mkdir(badDir, { recursive: true });
    await fs.rename(fullPath, path.join(badDir, `${Date.now()}-${name}`));
    log.warn(`spool entry ${name} is unusable; parked under signals/bad/`);
  } catch {
    // Best effort — a file we cannot even move must not break the drain.
  }
}

/**
 * Apply every spool file on this machine and delete the ones that landed.
 *
 * A file is removed only after its signal was accepted or was already resolved; anything still
 * addressable to a live waitpoint is left for the next tick. The filename doubles as the dedupe
 * key, so re-reading a file whose delete was lost is harmless.
 */
export async function drainLocalSpool(
  deps: IngestDeps = productionIngestDeps,
  dir: string = SIGNAL_SPOOL_DIR,
): Promise<number> {
  const badDir = path.join(dir, 'bad');
  const entries = await readSpoolDir(dir, badDir);
  let applied = 0;
  for (const entry of entries) {
    const outcome = await ingestSignal(toSignalInput(entry.payload, `spool:${entry.file}`, 'spool'), deps);
    if (outcome.kind === 'not-found' || outcome.kind === 'bad-secret') {
      await quarantine(path.join(dir, entry.file), entry.file, badDir);
      continue;
    }
    if (outcome.kind === 'rate-limited') continue;
    await fs.unlink(path.join(dir, entry.file)).catch(() => {});
    if (outcome.kind === 'accepted') applied += 1;
  }
  return applied;
}

/** Normalise an untrusted payload (HTTP body or spool file) into a SignalInput. */
export function toSignalInput(
  payload: Record<string, unknown>,
  dedupeKey: string | null,
  source: string,
): SignalInput {
  return {
    id: typeof payload.id === 'string' ? payload.id : '',
    secret: typeof payload.secret === 'string' ? payload.secret : '',
    status: payload.status === 'fail' || payload.status === 'progress' || payload.status === 'ok'
      ? payload.status
      : undefined,
    message: typeof payload.message === 'string' ? payload.message : null,
    data: payload.data ?? null,
    member: typeof payload.member === 'string' ? payload.member : null,
    source,
    dedupeKey,
  };
}
