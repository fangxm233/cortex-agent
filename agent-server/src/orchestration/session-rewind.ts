import { engines } from '@domain/runs/engines.js';
import type { PlatformAdapter } from '@platform/index.js';
import { createLogger } from '@core/log.js';
import { runRegistry } from '@core/run-registry.js';
import { conversationLedger, type ChannelConversation, type LedgerTurn } from '@store/conversation-ledger-repo.js';
import { conversationHistory } from '@store/conversation-history-repo.js';
import { sessionStore, effectiveBackendSessionId, type Session } from '@store/session-registry-repo.js';
import { resolveBackendForChannel } from '@domain/agents/index.js';
import { publishSessionRewound } from './session-events.js';
import { deliverToSessionDetached } from './session-gateway.js';
import { activeTurns } from './turn/active-turns.js';
import { tryAcquireTurnMutationLock } from './turn-mutation-lock.js';
import { applyRestore, planRestore, transcriptCutter, type RestorePlan, type TranscriptCutter } from './rewind-restore.js';
import type { AttachmentMeta } from '@domain/ui-service/types.js';

const log = createLogger('session-rewind');

export type RewindResult = { ok: true } | { ok: false; reason: 'running' | 'not-found' | 'no-restore-point' };

/** Injectable dependency surface (unit tests). Defaults bind the production singletons. */
export interface RewindDeps {
  activeAgents: { hasChannel(channel: string): boolean };
  snapshotPending(channel: string): boolean;
  tryAcquireMutation(channel: string): (() => void) | null;
  ledger: {
    getConversation(channel: string): Promise<ChannelConversation | null>;
    rollbackTo(channel: string, turnIndex: number): Promise<{ supersededTurns: LedgerTurn[]; conversation: ChannelConversation } | null>;
    truncateTurns(channel: string, fromIndex: number): Promise<void>;
  };
  history: {
    truncateFromTurn(sessionId: string, turnIndex: number): Promise<{ text: string; ts: string; attachments?: AttachmentMeta[] } | null>;
    appendEditMarker(sessionId: string, opts: { originalText: string; originalTs: string }): Promise<void>;
  };
  sessionStore: {
    getById(sessionId: string): Promise<Session | null>;
    updateSession(sessionId: string, updates: { backendSessionId: string | null }): Promise<void>;
  };
  transcript: TranscriptCutter;
  resolveBackend: (channel: string) => string;
  registerPISessionPath: (sessionId: string, sessionPath: string) => void;
  closePooledSession: (channel: string, backend: string) => void;
  send: (opts: {
    channel: string;
    text: string;
    attachments?: AttachmentMeta[];
    adapter: PlatformAdapter;
    mutationRelease?: () => void;
  }) => void;
  publishRewound: (payload: { sessionId: string; channel: string; turnIndex: number }) => void;
}

function defaultDeps(): RewindDeps {
  return {
    activeAgents: runRegistry,
    snapshotPending: (channel) => activeTurns.trackingPending(channel),
    tryAcquireMutation: tryAcquireTurnMutationLock,
    ledger: conversationLedger,
    history: conversationHistory,
    sessionStore,
    transcript: transcriptCutter,
    resolveBackend: (channel) => resolveBackendForChannel(channel),
    registerPISessionPath: (sessionId, sessionPath) => engines.registerSessionPath(sessionId, sessionPath),
    // Backend-neutral: every backend pools its subprocess, and a live one would keep the
    // pre-rewind history in memory and ignore the rolled-back transcript on disk.
    closePooledSession: (channel) => { void engines.close(channel); },
    send: (opts) => deliverToSessionDetached({ ...opts, origin: 'web-user' }),
    publishRewound: publishSessionRewound,
  };
}

/**
 * Edit a previously-sent user message and rewind the conversation to it: every turn from
 * `turnIndex` onward is rolled back (ledger + backend transcript + display history), then the
 * edited `text` is re-sent as a genuine user turn (original attachments preserved). Fire-and-forget
 * on the regeneration — the new reply streams over `session.message` as usual.
 *
 * Rejected while a run is live on the channel ('running' — the UI greys the edit action out too),
 * when the session/turn cannot be found ('not-found'), and when the backend cannot be put back to
 * where the turn started ('no-restore-point'). A rejection leaves everything untouched.
 */
export async function rewindWebSession(
  opts: { sessionId: string; channel: string; turnIndex: number; text: string; adapter: PlatformAdapter },
  deps: RewindDeps = defaultDeps(),
): Promise<RewindResult> {
  if (deps.snapshotPending(opts.channel)) return { ok: false, reason: 'running' };
  let releaseMutation = deps.tryAcquireMutation(opts.channel);
  if (!releaseMutation) return { ok: false, reason: 'running' };
  try {
    const result = await rewindLocked(opts, deps, releaseMutation);
    if (result.ok) releaseMutation = null;
    return result;
  } finally {
    releaseMutation?.();
  }
}

interface RewindContext {
  conversation: ChannelConversation;
  session: Session;
  backend: string;
  backendSessionId: string | null;
}

async function resolveRewindContext(
  opts: { sessionId: string; channel: string; turnIndex: number },
  deps: RewindDeps,
): Promise<RewindContext | null> {
  const conversation = await deps.ledger.getConversation(opts.channel);
  if (!conversation || opts.turnIndex < 0 || opts.turnIndex >= conversation.turns.length) return null;
  const session = await deps.sessionStore.getById(opts.sessionId);
  if (!session) return null;
  const backend = deps.resolveBackend(opts.channel) || conversation.backend;
  return { conversation, session, backend, backendSessionId: effectiveBackendSessionId(session) };
}

/** Point the backend at the restored transcript, or at a fresh session when there is none. */
async function settleBackendSession(
  context: RewindContext,
  plan: RestorePlan,
  restored: boolean,
  deps: RewindDeps,
): Promise<void> {
  if (restored && plan.kind === 'anchor') {
    if (context.backend === 'pi' && context.backendSessionId) {
      deps.registerPISessionPath(context.backendSessionId, plan.anchor.file);
    }
    return;
  }
  if (!restored) log.error('Transcript changed during rewind — starting a fresh backend session');
  await deps.sessionStore.updateSession(context.session.sessionId, { backendSessionId: null });
}

async function restoreRewindBackend(
  context: RewindContext,
  channel: string,
  turnIndex: number,
  plan: RestorePlan,
  deps: RewindDeps,
): Promise<void> {
  await deps.ledger.rollbackTo(channel, turnIndex);
  const restored = await applyRestore(plan, deps.transcript);
  await settleBackendSession(context, plan, restored, deps);
  deps.closePooledSession(channel, context.backend);
  await deps.ledger.truncateTurns(channel, turnIndex);
}

async function resendRewoundTurn(
  opts: { sessionId: string; channel: string; turnIndex: number; text: string; adapter: PlatformAdapter },
  conversation: ChannelConversation,
  deps: RewindDeps,
  mutationRelease: () => void,
): Promise<void> {
  const removed = await deps.history.truncateFromTurn(opts.sessionId, opts.turnIndex);
  const originalText = removed?.text ?? conversation.turns[opts.turnIndex]?.userMessageText ?? '';
  await deps.history.appendEditMarker(opts.sessionId, {
    originalText, originalTs: removed?.ts ?? '',
  });
  deps.publishRewound({ sessionId: opts.sessionId, channel: opts.channel, turnIndex: opts.turnIndex });
  deps.send({
    channel: opts.channel, text: opts.text, attachments: removed?.attachments,
    adapter: opts.adapter, mutationRelease,
  });
}

async function rewindLocked(
  opts: { sessionId: string; channel: string; turnIndex: number; text: string; adapter: PlatformAdapter },
  deps: RewindDeps,
  mutationRelease: () => void,
): Promise<RewindResult> {
  if (deps.activeAgents.hasChannel(opts.channel)) return { ok: false, reason: 'running' };
  const context = await resolveRewindContext(opts, deps);
  if (!context) return { ok: false, reason: 'not-found' };
  const turn = context.conversation.turns[opts.turnIndex];
  const plan = await planRestore(turn, opts.turnIndex, context.backendSessionId, deps.transcript);
  const where = { channel: opts.channel, turnIndex: opts.turnIndex, backend: context.backend };
  if (!plan) {
    log.warn('Rewind refused — no restore point for the turn:', where);
    return { ok: false, reason: 'no-restore-point' };
  }
  log.info('Rewinding session:', { ...where, restore: plan.kind });
  await restoreRewindBackend(context, opts.channel, opts.turnIndex, plan, deps);
  await resendRewoundTurn(opts, context.conversation, deps, mutationRelease);
  return { ok: true };
}
