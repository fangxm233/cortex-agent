import type { Waitpoint } from '@store/waitpoint-repo.js';
import type { WaitpointInfo, WaitpointSignalInfo } from '@domain/ui-service/types.js';

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
 * Kept as one function so `SessionInfo.waitingOn`, `waitpoints.list` and the agent's
 * `wait_check`/`wait_cancel` can never drift.
 */
export function ownsWaitpoint(wp: Waitpoint, sessionId: string, channel: string | null): boolean {
  if (sessionId && wp.owner.sessionId === sessionId) return true;
  if (channel && wp.owner.channel === channel) return true;
  return false;
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
      need: wp.quorum.need,
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
      pending: wp.delivery.pending || wp.delivery.inFlight === true,
      attempts: wp.delivery.attempts,
      lastError: wp.delivery.lastError ?? null,
      lastAt: wp.delivery.lastAt ?? null,
    },
    wakesLastHour: wp.wakes.filter((t) => t > windowStart).length,
    wakeLimit,
    rateLimited: wp.wakeHeld === true,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * The agent-facing view (`wait_create`/`wait_check`): the UI serialiser's output in the tool's
 * snake_case with ISO timestamps. Derived rather than written again, so the redaction lives in one
 * place. `resolved_at` is the one field the UI does not need (it only lists armed waitpoints).
 */
export function agentWaitpointView(wp: Waitpoint, now: number, wakeLimit: number): Record<string, unknown> {
  const info = toWaitpointInfo(wp, now, wakeLimit);
  return {
    id: info.id,
    label: info.label,
    intent: info.intent,
    state: info.state,
    quorum: info.quorum,
    fail_fast: info.failFast,
    fires: info.fires,
    max_signals: info.maxSignals,
    emit_from: info.emitFrom,
    created_at: iso(info.createdAt),
    expires_at: iso(info.expiresAt),
    resolved_at: wp.resolvedAt ? iso(wp.resolvedAt) : null,
    wakes_last_hour: info.wakesLastHour,
    wake_limit: info.wakeLimit,
    wake_held: info.rateLimited,
    signals: info.signals.map((s) => ({ ...s, at: iso(s.at) })),
  };
}
