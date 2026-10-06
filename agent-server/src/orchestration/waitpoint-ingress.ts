//
//         Two properties this layer owns and the service does not:
//         - anti-enumeration: unknown ids and bad secrets are rate-limited globally and logged,
//           so a typo in a training script is debuggable and a scan for live waitpoints is not
//           free.
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

/** A spool entry larger than this is refused outright — signals are summaries, not logs. */
export const SPOOL_FILE_MAX_BYTES = 64 * 1024;

// --- anti-enumeration ---

/**
 * Failed lookups (unknown id or bad secret) allowed per minute across all callers. Past it, every
 * further miss is answered `rate-limited` instead of `not-found`/`bad-secret`, so a scan can no
 * longer tell a live id from a dead one. The budget is charged after the lookup on purpose: refusing
 * before it would let anyone flooding the loopback port block every legitimate signal as well, and
 * the lookup itself is an in-memory read.
 */
const MISS_BUDGET_PER_MINUTE = 60;
let missWindowStart = 0;
let missCount = 0;

function recordRejection(reason: 'not-found' | 'bad-secret' | 'rate-limited', id: string, source: string): void {
  log.warn(`signal rejected (${reason}) for ${id || '(no id)'} from ${source}`);
}

/** Test hook. */
export function resetSignalIngressState(): void {
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
    recordRejection('not-found', String(input.id ?? ''), input.source);
    return { kind: 'not-found' };
  }

  const outcome = await applySignal(input, deps.service);

  if (outcome.kind === 'not-found' || outcome.kind === 'bad-secret') {
    if (overMissBudget(now)) {
      recordRejection('rate-limited', input.id, input.source);
      return { kind: 'rate-limited' };
    }
    recordRejection(outcome.kind, input.id, input.source);
    return outcome;
  }

  if (outcome.kind === 'accepted' && outcome.fired) {
    scheduleWaitpointDelivery(outcome.waitpoint, deps.notifier);
  }
  return outcome;
}

// --- spool disposition ---

/** What a drain does with a spool file once it has been read. One table for the local and the
 *  device drain, so the same outcome is never handled two different ways. */
export type SpoolDisposition = 'remove' | 'quarantine' | 'keep';

const SPOOL_DISPOSITION: Record<ApplySignalOutcome['kind'], SpoolDisposition> = {
  accepted: 'remove',
  // A replay of a file whose delete was lost: the filename is the dedupe key.
  duplicate: 'remove',
  // Late but authentic. Nothing will ever want it again.
  'already-resolved': 'remove',
  // These will never succeed. Parked rather than deleted so a broken writer can be found, and
  // never re-read, so they do not keep charging the miss budget every tick.
  'not-found': 'quarantine',
  'bad-secret': 'quarantine',
  'unknown-member': 'quarantine',
  // The global miss budget is spent; nothing was looked up. Try again next tick.
  'rate-limited': 'keep',
};

/** Parse and apply one spool file. A body that is not a JSON object is quarantined unread. */
export async function ingestSpoolEntry(
  body: string,
  dedupeKey: string,
  source: string,
  deps: IngestDeps = productionIngestDeps,
): Promise<{ disposition: SpoolDisposition; outcome: ApplySignalOutcome | null }> {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { disposition: 'quarantine', outcome: null };
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { disposition: 'quarantine', outcome: null };
  }
  const outcome = await ingestSignal(toSignalInput(payload as Record<string, unknown>, dedupeKey, source), deps);
  return { disposition: SPOOL_DISPOSITION[outcome.kind], outcome };
}

// --- local spool ---

interface SpoolEntry {
  file: string;
  body: string;
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
      entries.push({ file: name, body: await fs.readFile(full, 'utf8') });
    } catch {
      // An unreadable file must not stall the whole batch. Park it and move on.
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
 * Apply every spool file on this machine and dispose of each by its outcome (`SPOOL_DISPOSITION`).
 * The filename doubles as the dedupe key, so re-reading a file whose delete was lost is harmless.
 */
export async function drainLocalSpool(
  deps: IngestDeps = productionIngestDeps,
  dir: string = SIGNAL_SPOOL_DIR,
): Promise<number> {
  const badDir = path.join(dir, 'bad');
  const entries = await readSpoolDir(dir, badDir);
  let applied = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.file);
    const { disposition, outcome } = await ingestSpoolEntry(entry.body, `spool:${entry.file}`, 'spool', deps);
    if (disposition === 'quarantine') await quarantine(full, entry.file, badDir);
    else if (disposition === 'remove') await fs.unlink(full).catch(() => {});
    if (outcome?.kind === 'accepted') applied += 1;
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
