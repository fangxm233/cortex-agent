import type { Waitpoint } from '@store/waitpoint-repo.js';
import { getSettings } from '@core/settings.js';
import { ownsWaitpoint, toWaitpointInfo } from '@domain/waitpoints/view.js';
import type { UiServiceDeps, WaitpointInfo, QueryParams } from '../types.js';

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

export async function handleWaitpointsList(
  deps: UiServiceDeps,
  params: QueryParams<'waitpoints.list'>,
): Promise<WaitpointInfo[]> {
  const sessionId = String(params.sessionId || '');
  if (!sessionId) return [];

  // The channel half of the ownership rule has to be resolved here: SessionInfo carries no channel,
  // so the client cannot compute this match and must not try to guess it (`web:<id>` only holds for
  // sessions created directly — a Slack, Feishu or scheduled session has a different conduit).
  const record = await deps.sessionStore.getById(sessionId);
  const channel: string | null = record?.channel ?? null;

  const armed = (await deps.waitpointRegistry.list()).filter(wp => wp.state === 'armed' || wp.delivery.pending);
  const mine = armed.filter((wp) => ownsWaitpoint(wp, sessionId, channel));

  const now = Date.now();
  const wakeLimit = getSettings().waitpointMaxWakesPerHour;
  // Soonest to expire first: what is about to time out is what a human needs to see.
  mine.sort((a, b) => a.expiresAt - b.expiresAt);
  return mine.map((wp) => toWaitpointInfo(wp, now, wakeLimit));
}
