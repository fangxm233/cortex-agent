// input:  UiServiceDeps + WaitpointsListParams
// output: handleWaitpointsList → WaitpointInfo[]; ownsWaitpoint (the ownership rule, shared with
//         query/sessions.ts); toWaitpointInfo (the redacting serialiser)
// pos:    query handler for 'waitpoints.list' — the operator-facing view of the waitpoints a
//         session is still waiting on. Deliberately NOT domain/waitpoints' `publicView`: that one
//         is written for the agent and hides exactly the fields a human needs (delivery state, wake
//         budget, rate-limit latch). Records reach this file only through UiServiceDeps.

import type { Waitpoint } from '@store/waitpoint-repo.js';
import { getSettings } from '@core/settings.js';
import type {
  UiServiceDeps,
  WaitpointInfo,
  WaitpointSignalInfo,
  WaitpointsListParams,
} from '../types.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Does `wp` belong to the session identified by (`sessionId`, `channel`)?
 *
 * The union of two clauses, each covering the other's blind spot:
 *   - `owner.sessionId` — this session's own process armed it. Survives a channel rebind, since
 *     `bindChannel` never rewrites the session record's channel.
 *   - `owner.channel` — the wake will be DELIVERED here. Survives the session being recreated
 *     (`!new`, a scheduled re-run), because delivery is channel-addressed and find-or-creates a
 *     session. This clause can surface a waitpoint armed by an earlier session on the same channel;
 *     that is honest rather than wrong — its wake really will land on the current one.
 *
 * Kept as one exported function so `SessionInfo.waitingOn` and `waitpoints.list` can never drift.
 */
export function ownsWaitpoint(wp: Waitpoint, sessionId: string, channel: string | null): boolean {
  if (sessionId && wp.owner.sessionId === sessionId) return true;
  if (channel && wp.owner.channel === channel) return true;
  return false;
}

/** Count the armed waitpoints each of `sessions` is waiting on. One pass over a handful of records
 *  (the repo read is an in-memory cache hit and settled records are purged after 3 days), so the
 *  nested loop is cheaper than building and reconciling two indexes. */
export function countWaitingOn(
  armed: Waitpoint[],
  sessions: Array<{ sessionId: string; channel: string | null }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    if (armed.length === 0) { out.set(s.sessionId, 0); continue; }
    let n = 0;
    for (const wp of armed) if (ownsWaitpoint(wp, s.sessionId, s.channel)) n += 1;
    out.set(s.sessionId, n);
  }
  return out;
}

/** `quorum.need` is collapsed to a number at creation, but the stored type still permits `'all'`
 *  (a hand-edited or pre-existing waitpoints.json). Same fallback every other reader uses. */
function needCount(wp: Waitpoint): number {
  return typeof wp.quorum.need === 'number' ? wp.quorum.need : wp.quorum.members.length || 1;
}

function toSignalInfo(s: Waitpoint['signals'][number]): WaitpointSignalInfo {
  return {
    at: s.at,
    status: s.status,
    member: s.member ?? null,
    message: s.message ?? null,
    source: s.source,
  };
}

/**
 * Redacting serialiser. Built field by field, never by spreading the record: `secretHash` must not
 * be able to leak through a field added upstream later. `signals[].data` is dropped on purpose —
 * it is externally written and capped at 16 KB per signal, which would bloat every list response.
 */
export function toWaitpointInfo(wp: Waitpoint, now: number, wakeLimit: number): WaitpointInfo {
  const windowStart = now - HOUR_MS;
  return {
    id: wp.id,
    label: wp.label,
    intent: wp.intent,
    state: wp.state,
    emitFrom: wp.emitFrom.kind === 'device'
      ? { kind: 'device', device: wp.emitFrom.device }
      : { kind: 'local' },
    quorum: {
      need: needCount(wp),
      got: wp.quorum.got.length,
      members: [...wp.quorum.members],
    },
    failFast: wp.failFast,
    fires: wp.fires,
    maxSignals: wp.maxSignals,
    createdAt: wp.createdAt,
    expiresAt: wp.expiresAt,
    signals: wp.signals.map(toSignalInfo),
    delivery: {
      pending: wp.delivery.pending,
      attempts: wp.delivery.attempts,
      lastError: wp.delivery.lastError ?? null,
      lastAt: wp.delivery.lastAt ?? null,
    },
    wakesLastHour: wp.wakes.filter((t) => t > windowStart).length,
    wakeLimit,
    rateLimited: wp.rateLimitNotified === true,
  };
}

export async function handleWaitpointsList(
  deps: UiServiceDeps,
  params: WaitpointsListParams,
): Promise<WaitpointInfo[]> {
  if (!deps.waitpointRegistry) return [];
  const sessionId = String(params.sessionId || '');
  if (!sessionId) return [];

  // The channel half of the ownership rule has to be resolved here: SessionInfo carries no channel,
  // so the client cannot compute this match and must not try to guess it (`web:<id>` only holds for
  // sessions created directly — a Slack, Feishu or scheduled session has a different conduit).
  const record = await deps.sessionStore.getById(sessionId);
  const channel: string | null = record?.channel ?? null;

  const armed = await deps.waitpointRegistry.listArmed();
  const mine = armed.filter((wp) => ownsWaitpoint(wp, sessionId, channel));

  const now = Date.now();
  const wakeLimit = getSettings().waitpointMaxWakesPerHour;
  // Soonest to expire first: what is about to time out is what a human needs to see.
  mine.sort((a, b) => a.expiresAt - b.expiresAt);
  return mine.map((wp) => toWaitpointInfo(wp, now, wakeLimit));
}
