import type { SessionContextUsage } from '@core/types/agent-types.js';
import { channelEngineBusy } from '@core/session-state.js';
import { getSessionAsync } from '@domain/sessions/session.js';
import {
  effectiveBackendSessionId,
  sessionStore,
  type Session,
} from '@store/session-registry-repo.js';
import { compactAgentContext, isSessionCompactionSupported } from '@domain/runs/compact.js';
import type { AgentCompactResult, Backend } from '../agent-adapter/types.js';
import { conduitQueues, enqueueAndWait } from './conduit-queue.js';
import { conversationEngineRequest } from './conversation-request.js';
import { publishSessionContextCompacted } from './session-events.js';
import { withTurnBrowser } from './turn/turn-prep.js';

export type CompactSessionOutcome =
  | { ok: true; status: 'compacted' | 'not-needed'; contextUsage: SessionContextUsage | null }
  | { ok: false; reason: 'not-found' | 'unsupported' | 'running' };

export type CompactActiveSessionOutcome =
  | CompactSessionOutcome
  | { ok: false; reason: 'no-session' };

export interface CompactSessionDeps {
  sessions: {
    getById(sessionId: string): Promise<Session | null>;
    updateContextUsage(sessionId: string, usage: SessionContextUsage | null): Promise<void>;
    /** Compaction removes the already-delivered [Board] block from backend history, so the
     *  delivery marker has to go with it or the block is never seen again. */
    clearBoardBlockDelivery(sessionId: string): Promise<unknown>;
  };
  /** The registry's one answer to "may a command touch this session's pooled engine": see
   *  `core/session-state.ts`'s `channelEngineBusy`. */
  engineBusy(session: { sessionId: string; channel: string }): boolean;
  queue: {
    has(channel: string): boolean;
    run<T>(channel: string, fn: () => Promise<T>): Promise<T>;
  };
  supports(session: { backend: string; profileName: string | null }): boolean;
  /** Compact the session's live engine, which holds `backendSessionId`. */
  compactAgent(session: Session, backendSessionId: string): Promise<AgentCompactResult>;
  publish(event: {
    sessionId: string;
    channel: string;
    status: 'compacted';
    contextUsage: SessionContextUsage | null;
  }): void;
  now(): string;
}

const defaultDeps: CompactSessionDeps = {
  sessions: sessionStore,
  engineBusy: (session) => channelEngineBusy(session.channel, session.sessionId),
  queue: {
    has: (channel) => conduitQueues.has(channel),
    run: enqueueAndWait,
  },
  supports: isSessionCompactionSupported,
  compactAgent: compactLiveEngine,
  publish: publishSessionContextCompacted,
  now: () => new Date().toISOString(),
};

/**
 * Compaction asks the pool for the session's engine exactly as the session's next turn would: the
 * same request (agent, profile, policy, route) and the same browser, held for the command. Anything
 * else is a different identity, and the pool would respawn the process — compacting a fresh one
 * and leaving the next turn to respawn it again.
 */
function compactLiveEngine(session: Session, backendSessionId: string): Promise<AgentCompactResult> {
  const { backend, channel } = session;
  return withTurnBrowser({ backend, browser: session.browser ?? null }, (cdpEndpoint) => compactAgentContext({
    backend: backend as Backend,
    request: conversationEngineRequest({
      ids: {
        sessionId: session.sessionId, backendSessionId,
        projectId: session.projectId ?? 'general',
      },
      channel, session, browserCdpEndpoint: cdpEndpoint, trigger: 'manual-compact',
    }),
  }));
}

function currentUsage(session: Session): SessionContextUsage | null {
  return session.contextUsage ?? null;
}

async function applyCompactResult(
  session: Session,
  result: AgentCompactResult,
  deps: CompactSessionDeps,
): Promise<CompactSessionOutcome> {
  if (result.status === 'not-needed') {
    return { ok: true, status: 'not-needed', contextUsage: currentUsage(session) };
  }
  const contextUsage = result.contextUsage
    ? { ...result.contextUsage, updatedAt: deps.now() }
    : null;
  await deps.sessions.updateContextUsage(session.sessionId, contextUsage);
  await deps.sessions.clearBoardBlockDelivery(session.sessionId);
  deps.publish({
    sessionId: session.sessionId,
    channel: session.channel,
    status: 'compacted',
    contextUsage,
  });
  return { ok: true, status: 'compacted', contextUsage };
}

export async function compactActiveSessionContext(
  opts: { channel: string },
): Promise<CompactActiveSessionOutcome> {
  const sessionId = await getSessionAsync(opts.channel);
  if (!sessionId) return { ok: false, reason: 'no-session' };
  return compactSessionContext(sessionId);
}

export async function compactSessionContext(
  sessionId: string,
  deps: CompactSessionDeps = defaultDeps,
): Promise<CompactSessionOutcome> {
  const session = await deps.sessions.getById(sessionId);
  if (!session) return { ok: false, reason: 'not-found' };
  if (!deps.supports(session)) return { ok: false, reason: 'unsupported' };
  // Two questions, and they are not the same one: is the engine this command targets in use
  // (the registry), and is a compaction of this channel already queued (the conduit queue, which
  // is what serializes two compactions). The registry used to be asked twice under two names.
  const busy = deps.engineBusy(session) || deps.queue.has(session.channel);
  if (busy) return { ok: false, reason: 'running' };
  const backendSessionId = effectiveBackendSessionId(session);
  if (!backendSessionId) {
    return { ok: true, status: 'not-needed', contextUsage: currentUsage(session) };
  }
  return deps.queue.run(session.channel, async () => {
    const result = await deps.compactAgent(session, backendSessionId);
    return applyCompactResult(session, result, deps);
  });
}
