// input:  waitpoint-repo (Waitpoint records), settings (ttl / rate cap)
// output: createWaitpoint / applySignal / cancelWaitpoint / expireDueWaitpoints / listWaitpointsForSession
// pos:    Waitpoint domain logic. Pure state machine over the repo: no HTTP, no delivery, no timers.
//         Firing only sets `delivery.pending`; turning that into a wake turn is notifier.ts's job, so
//         this module stays synchronously testable and delivery failures can be retried from disk.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import {
  waitpointRepo as defaultRepo,
  type Waitpoint,
  type WaitpointEmitFrom,
  type WaitpointOwner,
  type WaitpointRepo,
  type WaitpointSignal,
  type SignalStatus,
} from '@store/waitpoint-repo.js';

const log = createLogger('waitpoints');

/** Hard ceiling on a waitpoint's lifetime. An unbounded waitpoint is an unbounded credential. */
export const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Resolved records linger this long so a late signal still gets a meaningful 410 instead of a 404. */
export const RESOLVED_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
export const DEFAULT_COALESCE_MS = 3000;
export const MESSAGE_MAX_CHARS = 2000;
export const DATA_MAX_CHARS = 16000;

export interface WaitpointServiceDeps {
  repo: Pick<WaitpointRepo, 'get' | 'list' | 'listArmed' | 'insert' | 'update' | 'mutate' | 'remove'>;
  now: () => number;
  /** Sliding-window cap on wakes per waitpoint per hour. */
  maxWakesPerHour: () => number;
  /** Lifetime applied when the caller does not ask for one. */
  defaultTtlMs: () => number;
  newId: () => string;
  newSecret: () => string;
}

export const productionWaitpointDeps: WaitpointServiceDeps = {
  repo: defaultRepo,
  now: () => Date.now(),
  // Read through getSettings() on every call so a live settings change takes effect without a restart.
  maxWakesPerHour: () => getSettings().waitpointMaxWakesPerHour,
  defaultTtlMs: () => getSettings().waitpointTtlMs,
  newId: () => `wp_${randomBytes(6).toString('hex')}`,
  newSecret: () => randomBytes(16).toString('hex'),
};

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time compare of two hex digests. Length mismatch and empty input never match. */
function secretMatches(expectedHash: string, provided: unknown): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(expectedHash, 'utf8');
  const b = Buffer.from(hashSecret(provided), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// --- create ---

export interface CreateWaitpointInput {
  label: string;
  intent: string;
  owner: WaitpointOwner;
  quorum?: { need?: number | 'all'; members?: string[] };
  failFast?: boolean;
  maxSignals?: number;
  coalesceMs?: number;
  ttlMs?: number;
  emitFrom?: WaitpointEmitFrom;
}

export interface CreateWaitpointResult {
  waitpoint: Waitpoint;
  /** Plaintext capability. Returned exactly once; only its hash is persisted. */
  secret: string;
}

function clampTtl(ttlMs: number | undefined, fallbackMs: number): number {
  const fallback = Number.isFinite(fallbackMs) && fallbackMs > 0 ? Math.min(fallbackMs, MAX_TTL_MS) : DEFAULT_TTL_MS;
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) return fallback;
  return Math.min(ttlMs, MAX_TTL_MS);
}

/** Always resolves to a concrete count — `'all'` is collapsed here so nothing downstream re-derives it. */
function resolveQuorum(input: CreateWaitpointInput): { need: number; members: string[]; got: string[] } {
  const members = (input.quorum?.members ?? []).map((m) => String(m)).filter(Boolean);
  const rawNeed = input.quorum?.need;
  if (rawNeed === 'all') return { need: members.length > 0 ? members.length : 1, members, got: [] };
  const need = typeof rawNeed === 'number' && Number.isFinite(rawNeed) && rawNeed > 0
    ? Math.floor(rawNeed)
    : (members.length > 0 ? members.length : 1);
  return { need, members, got: [] };
}

export async function createWaitpoint(
  input: CreateWaitpointInput,
  deps: WaitpointServiceDeps = productionWaitpointDeps,
): Promise<CreateWaitpointResult> {
  const now = deps.now();
  const secret = deps.newSecret();
  const quorum = resolveQuorum(input);
  const maxSignals = typeof input.maxSignals === 'number' && input.maxSignals > 0
    ? Math.floor(input.maxSignals)
    : 1;
  const waitpoint: Waitpoint = {
    id: deps.newId(),
    secretHash: hashSecret(secret),
    label: input.label,
    intent: input.intent,
    owner: input.owner,
    emitFrom: input.emitFrom ?? { kind: 'local' },
    quorum,
    failFast: input.failFast ?? true,
    maxSignals,
    fires: 0,
    coalesceMs: typeof input.coalesceMs === 'number' && input.coalesceMs >= 0
      ? input.coalesceMs
      : (quorum.need > 1 ? DEFAULT_COALESCE_MS : 0),
    createdAt: now,
    expiresAt: now + clampTtl(input.ttlMs, deps.defaultTtlMs()),
    resolvedAt: null,
    state: 'armed',
    signals: [],
    delivery: { pending: false, attempts: 0, lastError: null, lastAt: null },
    wakes: [],
  };
  await deps.repo.insert(waitpoint);
  log.info(`created ${waitpoint.id} "${waitpoint.label}" for ${waitpoint.owner.channel} (need ${quorum.need})`);
  return { waitpoint, secret };
}

// --- signal ---

export interface SignalInput {
  id: string;
  secret: string;
  status?: SignalStatus;
  message?: string | null;
  data?: unknown;
  member?: string | null;
  /** Provenance for the notice: `http`, `spool`, `device:<name>`. */
  source: string;
  /** Idempotency key; a repeat of one already recorded is dropped. */
  dedupeKey?: string | null;
}

export type ApplySignalOutcome =
  | { kind: 'accepted'; waitpoint: Waitpoint; fired: boolean }
  | { kind: 'duplicate'; waitpoint: Waitpoint }
  | { kind: 'not-found' }
  | { kind: 'bad-secret' }
  | { kind: 'already-resolved'; state: Waitpoint['state']; resolvedAt: number | null }
  /** The signal was recorded but no wake was sent. `waitpoint` is absent when the refusal happened
   *  before lookup (global miss budget) rather than at the per-waitpoint cap. */
  | { kind: 'rate-limited'; waitpoint?: Waitpoint };

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

function normalizeStatus(status: unknown): SignalStatus {
  return status === 'fail' || status === 'progress' ? status : 'ok';
}

/** Clip untrusted payloads before they can reach a prompt. Non-strings are JSON-encoded first. */
function normalizeData(data: unknown): unknown {
  if (data === undefined || data === null) return null;
  if (typeof data === 'string') return truncate(data, DATA_MAX_CHARS);
  try {
    const encoded = JSON.stringify(data);
    if (typeof encoded !== 'string') return null;
    return encoded.length <= DATA_MAX_CHARS ? data : truncate(encoded, DATA_MAX_CHARS);
  } catch {
    return null;
  }
}

export async function applySignal(
  input: SignalInput,
  deps: WaitpointServiceDeps = productionWaitpointDeps,
): Promise<ApplySignalOutcome> {
  const now = deps.now();
  const maxWakes = deps.maxWakesPerHour();
  const existing = await deps.repo.get(input.id);
  if (!existing) return { kind: 'not-found' };
  if (!secretMatches(existing.secretHash, input.secret)) return { kind: 'bad-secret' };

  const outcome = await deps.repo.update<ApplySignalOutcome>(input.id, (wp) => {
    if (wp.state !== 'armed') {
      return { next: wp, result: { kind: 'already-resolved', state: wp.state, resolvedAt: wp.resolvedAt ?? null } };
    }
    if (wp.expiresAt <= now) {
      wp.state = 'expired';
      wp.resolvedAt = now;
      return { next: wp, result: { kind: 'already-resolved', state: 'expired', resolvedAt: now } };
    }
    if (input.dedupeKey && wp.signals.some((s) => s.dedupeKey === input.dedupeKey)) {
      return { next: wp, result: { kind: 'duplicate', waitpoint: wp } };
    }

    const status = normalizeStatus(input.status);
    const signal: WaitpointSignal = {
      at: now,
      status,
      member: input.member ?? null,
      message: input.message ? truncate(String(input.message), MESSAGE_MAX_CHARS) : null,
      data: normalizeData(input.data),
      source: input.source,
      dedupeKey: input.dedupeKey ?? null,
    };
    wp.signals.push(signal);

    // `progress` is a heartbeat: recorded, never resolving, never waking.
    if (status === 'progress') return { next: wp, result: { kind: 'accepted', waitpoint: wp, fired: false } };

    const key = signal.member && signal.member.length > 0 ? signal.member : `#${wp.quorum.got.length + 1}`;
    if (!wp.quorum.got.includes(key)) wp.quorum.got.push(key);

    const need = typeof wp.quorum.need === 'number' ? wp.quorum.need : wp.quorum.members.length || 1;
    const shouldFire = (status === 'fail' && wp.failFast) || wp.quorum.got.length >= need;
    if (!shouldFire) return { next: wp, result: { kind: 'accepted', waitpoint: wp, fired: false } };

    // Sliding-window wake cap. The signal is still recorded; only the wake is withheld.
    const windowStart = now - 60 * 60 * 1000;
    wp.wakes = wp.wakes.filter((t) => t > windowStart);
    if (wp.wakes.length >= maxWakes) {
      const firstTime = !wp.rateLimitNotified;
      wp.rateLimitNotified = true;
      if (!firstTime) return { next: wp, result: { kind: 'rate-limited', waitpoint: wp } };
      // The first time the cap bites, fall through and deliver — the notice carries the warning.
    }

    wp.fires += 1;
    wp.wakes.push(now);
    wp.delivery.pending = true;
    if (wp.fires >= wp.maxSignals) {
      wp.state = 'fired';
      wp.resolvedAt = now;
    } else {
      wp.quorum.got = [];
    }
    return { next: wp, result: { kind: 'accepted', waitpoint: wp, fired: true } };
  });

  return outcome ?? { kind: 'not-found' };
}

// --- cancel / expire / query ---

export async function cancelWaitpoint(
  id: string,
  deps: WaitpointServiceDeps = productionWaitpointDeps,
): Promise<{ cancelled: boolean; state?: Waitpoint['state'] }> {
  const now = deps.now();
  const result = await deps.repo.update<{ cancelled: boolean; state: Waitpoint['state'] }>(id, (wp) => {
    if (wp.state !== 'armed') return { next: wp, result: { cancelled: false, state: wp.state } };
    wp.state = 'cancelled';
    wp.resolvedAt = now;
    wp.delivery.pending = false;
    return { next: wp, result: { cancelled: true, state: 'cancelled' } };
  });
  return result ?? { cancelled: false };
}

/**
 * Mark every past-due armed waitpoint expired and purge resolved ones past the retention window.
 * Returns the newly expired records so the caller can tell their owner nobody ever signalled.
 */
export async function expireDueWaitpoints(
  deps: WaitpointServiceDeps = productionWaitpointDeps,
): Promise<{ expired: Waitpoint[]; purged: number }> {
  const now = deps.now();
  return deps.repo.mutate((data) => {
    const expired: Waitpoint[] = [];
    let purged = 0;
    for (const [id, wp] of Object.entries(data)) {
      if (wp.state === 'armed' && wp.expiresAt <= now) {
        wp.state = 'expired';
        wp.resolvedAt = now;
        expired.push(wp);
        continue;
      }
      const resolvedAt = wp.resolvedAt ?? 0;
      const settled = wp.state !== 'armed' && !wp.delivery.pending;
      if (settled && resolvedAt > 0 && now - resolvedAt > RESOLVED_RETENTION_MS) {
        delete data[id];
        purged += 1;
      }
    }
    return { next: data, result: { expired, purged } };
  });
}

export async function listWaitpointsForSession(
  sessionId: string,
  deps: WaitpointServiceDeps = productionWaitpointDeps,
): Promise<Waitpoint[]> {
  return (await deps.repo.list()).filter((wp) => wp.owner.sessionId === sessionId);
}

/** Public view of a waitpoint — never leaks `secretHash`. */
export function publicView(wp: Waitpoint): Record<string, unknown> {
  const need = typeof wp.quorum.need === 'number' ? wp.quorum.need : wp.quorum.members.length || 1;
  return {
    id: wp.id,
    label: wp.label,
    intent: wp.intent,
    state: wp.state,
    quorum: { need, got: wp.quorum.got.length, members: wp.quorum.members },
    fires: wp.fires,
    max_signals: wp.maxSignals,
    emit_from: wp.emitFrom,
    created_at: new Date(wp.createdAt).toISOString(),
    expires_at: new Date(wp.expiresAt).toISOString(),
    resolved_at: wp.resolvedAt ? new Date(wp.resolvedAt).toISOString() : null,
    signals: wp.signals.map((s) => ({
      at: new Date(s.at).toISOString(),
      status: s.status,
      member: s.member,
      message: s.message,
      source: s.source,
    })),
  };
}
