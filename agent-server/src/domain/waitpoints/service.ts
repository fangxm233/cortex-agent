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
import { ownsWaitpoint } from './view.js';

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
  repo: Pick<WaitpointRepo, 'get' | 'list' | 'insert' | 'update' | 'mutate'>;
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
  /** `held`: the signal earned a wake but the hourly cap is full; the sweep delivers it later. */
  | { kind: 'accepted'; waitpoint: Waitpoint; fired: boolean; held?: boolean }
  | { kind: 'duplicate'; waitpoint: Waitpoint }
  | { kind: 'not-found' }
  | { kind: 'bad-secret' }
  /** `members` were declared and this signal named someone else. Nothing was recorded. */
  | { kind: 'unknown-member'; member: string; members: string[] }
  | { kind: 'already-resolved'; state: Waitpoint['state']; resolvedAt: number | null }
  /** Refused before lookup: the global miss budget (ingress anti-enumeration) is spent. */
  | { kind: 'rate-limited' };

const HOUR_MS = 60 * 60 * 1000;

/** Trim the sliding window and say whether one more wake fits under the hourly cap. */
function hasWakeRoom(wp: Waitpoint, now: number, maxWakes: number): boolean {
  wp.wakes = wp.wakes.filter((t) => t > now - HOUR_MS);
  return wp.wakes.length < Math.max(1, maxWakes);
}

/** Record one wake: the delivery WAL bit, the cap window, and the state transition. */
function fire(wp: Waitpoint, now: number): void {
  wp.fires += 1;
  wp.wakes.push(now);
  wp.wakeHeld = false;
  wp.delivery.pending = true;
  wp.lastFireGot = wp.quorum.got.length;
  if (wp.fires >= wp.maxSignals) {
    wp.state = 'fired';
    wp.resolvedAt = now;
  } else {
    wp.quorum.got = [];
  }
}

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
    const member = input.member ? String(input.member) : null;
    if (member && wp.quorum.members.length > 0 && !wp.quorum.members.includes(member)) {
      return { next: wp, result: { kind: 'unknown-member', member, members: [...wp.quorum.members] } };
    }
    if (input.dedupeKey && wp.signals.some((s) => s.dedupeKey === input.dedupeKey)) {
      return { next: wp, result: { kind: 'duplicate', waitpoint: wp } };
    }

    const status = normalizeStatus(input.status);
    const signal: WaitpointSignal = {
      at: now,
      status,
      member,
      message: input.message ? truncate(String(input.message), MESSAGE_MAX_CHARS) : null,
      data: normalizeData(input.data),
      source: input.source,
      dedupeKey: input.dedupeKey ?? null,
    };
    wp.signals.push(signal);

    // `progress` is a heartbeat: recorded, never resolving, never waking.
    if (status === 'progress') return { next: wp, result: { kind: 'accepted', waitpoint: wp, fired: false } };

    const key = member ?? `#${wp.quorum.got.length + 1}`;
    if (!wp.quorum.got.includes(key)) wp.quorum.got.push(key);

    const shouldFire = (status === 'fail' && wp.failFast) || wp.quorum.got.length >= wp.quorum.need;
    if (!shouldFire) return { next: wp, result: { kind: 'accepted', waitpoint: wp, fired: false } };

    // Sliding-window wake cap. The signal is recorded either way; a wake over the cap is held and
    // released by the sweep (`releaseHeldWakes`) once the window has room again.
    if (!hasWakeRoom(wp, now, maxWakes)) {
      wp.wakeHeld = true;
      return { next: wp, result: { kind: 'accepted', waitpoint: wp, fired: false, held: true } };
    }
    fire(wp, now);
    return { next: wp, result: { kind: 'accepted', waitpoint: wp, fired: true } };
  });

  return outcome ?? { kind: 'not-found' };
}

/**
 * Fire every wake the hourly cap was holding once its window has room. Returns the waitpoints that
 * fired; their `delivery.pending` is set, so the sweep's delivery pass sends them. A held wake on a
 * waitpoint past its deadline is left for the expiry notice, which carries its signals.
 */
export async function releaseHeldWakes(
  deps: WaitpointServiceDeps = productionWaitpointDeps,
): Promise<Waitpoint[]> {
  const now = deps.now();
  const maxWakes = deps.maxWakesPerHour();
  return deps.repo.mutate((data) => {
    const released: Waitpoint[] = [];
    for (const wp of Object.values(data)) {
      if (!wp.wakeHeld || wp.state !== 'armed' || wp.expiresAt <= now) continue;
      if (!hasWakeRoom(wp, now, maxWakes)) continue;
      fire(wp, now);
      wp.delivery.heldByCap = true;
      released.push(wp);
    }
    return { next: data, result: released };
  });
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
    wp.wakeHeld = false;
    wp.delivery.pending = false;
    return { next: wp, result: { cancelled: true, state: 'cancelled' } };
  });
  return result ?? { cancelled: false };
}

/** Cancel every armed waitpoint these (deleted) sessions armed. Returns how many were disarmed. */
export async function cancelWaitpointsForSessions(
  sessionIds: Iterable<string>,
  deps: WaitpointServiceDeps = productionWaitpointDeps,
): Promise<number> {
  const ids = new Set(sessionIds);
  if (ids.size === 0) return 0;
  const now = deps.now();
  return deps.repo.mutate((data) => {
    let cancelled = 0;
    for (const wp of Object.values(data)) {
      if (wp.state !== 'armed' || !ids.has(wp.owner.sessionId)) continue;
      wp.state = 'cancelled';
      wp.resolvedAt = now;
      wp.wakeHeld = false;
      wp.delivery.pending = false;
      cancelled += 1;
    }
    if (cancelled > 0) log.info(`cancelled ${cancelled} waitpoint(s) of ${ids.size} deleted session(s)`);
    return { next: data, result: cancelled };
  });
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
        wp.wakeHeld = false;
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

/** Every waitpoint (any state) owned by this session or delivered to its channel — the same
 *  ownership rule the UI applies, so the agent and the user see the same set. */
export async function listOwnedWaitpoints(
  sessionId: string,
  channel: string | null,
  deps: WaitpointServiceDeps = productionWaitpointDeps,
): Promise<Waitpoint[]> {
  return (await deps.repo.list()).filter((wp) => ownsWaitpoint(wp, sessionId, channel));
}
