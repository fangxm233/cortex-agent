import type { SessionContextUsage } from '@core/types/agent-types.js';
import { channelEngineBusy } from '@core/session-state.js';
import { runRegistry } from '@core/run-registry.js';
import { sessionRepo } from '@store/session-repo.js';
import {
  effectiveBackendSessionId,
  sessionStore,
  type Session,
} from '@store/session-registry-repo.js';
import {
  compactAgentContext,
  isSessionCompactionSupported,
  type CompactAgentRequest,
} from '@domain/runs/compact.js';
import { resolveBackendForChannel } from '@domain/agents/config.js';
import type { AgentCompactResult } from '../agent-adapter/types.js';
import { conduitQueues, enqueueAndWait } from './conduit-queue.js';
import { publishSessionContextCompacted } from './session-events.js';

export type CompactSessionOutcome =
  | { ok: true; status: 'compacted' | 'not-needed'; contextUsage: SessionContextUsage | null }
  | { ok: false; reason: 'not-found' | 'unsupported' | 'running' };

export type CompactActiveSessionOutcome =
  | CompactSessionOutcome
  | { ok: false; reason: 'no-session' };

interface CompactSessionRecord {
  name: string;
  sessionId: string;
  backendSessionId?: string | null;
  projectId: string;
  channel: string;
  backend: string;
  profileName: string | null;
  contextUsage?: SessionContextUsage;
}

export interface CompactSessionDeps {
  sessions: {
    getById(sessionId: string): Promise<CompactSessionRecord | null>;
    updateContextUsage(sessionId: string, usage: SessionContextUsage | null): Promise<void>;
    /** Compaction removes the already-delivered [Commission] block from backend history, so the
     *  delivery marker has to go with it or the block is never seen again (DR-0037 v4). */
    clearCommissionBlockDelivery(sessionId: string): Promise<unknown>;
  };
  /** The registry's one answer to "may a command touch this session's pooled engine": see
   *  `core/session-state.ts`'s `channelEngineBusy`. */
  engineBusy(session: { sessionId: string; channel: string }): boolean;
  queue: {
    has(channel: string): boolean;
    run<T>(channel: string, fn: () => Promise<T>): Promise<T>;
  };
  supports(session: { backend: string; profileName: string | null }): boolean;
  compactAgent(request: CompactAgentRequest): Promise<AgentCompactResult>;
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
  compactAgent: compactAgentContext,
  publish: publishSessionContextCompacted,
  now: () => new Date().toISOString(),
};

function compactRequest(session: CompactSessionRecord, backendSessionId: string): CompactAgentRequest {
  return {
    sessionId: session.sessionId,
    backend: session.backend as CompactAgentRequest['backend'],
    backendSessionId,
    channel: session.channel,
    profileName: session.profileName,
    projectId: session.projectId,
    sessionName: session.name,
  };
}

function currentUsage(session: CompactSessionRecord): SessionContextUsage | null {
  return session.contextUsage ?? null;
}

async function applyCompactResult(
  session: CompactSessionRecord,
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
  await deps.sessions.clearCommissionBlockDelivery(session.sessionId);
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
  const backend = resolveBackendForChannel(opts.channel);
  const sessionId = await sessionRepo.getSessionAsync(opts.channel);
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
  const backendSessionId = effectiveBackendSessionId(session as Session);
  if (!backendSessionId) {
    return { ok: true, status: 'not-needed', contextUsage: currentUsage(session) };
  }
  return deps.queue.run(session.channel, async () => {
    const result = await deps.compactAgent(compactRequest(session, backendSessionId));
    return applyCompactResult(session, result, deps);
  });
}
