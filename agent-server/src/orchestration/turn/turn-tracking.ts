import type { TurnMutationRelease } from '../turn-mutation-lock.js';
import { acquireTurnMutationLock } from '../turn-mutation-lock.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { anchorTranscriptEnd } from '@domain/sessions/session-transcript.js';
import type { TurnAnchor } from '@core/types/transcript-anchor.js';
import { resolveRunSelection } from '@domain/runs/config-resolver.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { sessionSpawnCwd } from '@core/paths.js';
import type { EngineSelection } from '@domain/agents/engine-selection.js';

interface TurnTrackingDeps {
  getSelection(channel: string, sessionId: string | null): EngineSelection | Promise<EngineSelection>;
  ledger: Pick<typeof conversationLedger, 'initAndBeginTurn'>;
  /** Where the backend session's transcript currently ends; null when it has none yet. */
  anchorEnd(backend: string, backendSessionId: string, cwd?: string): Promise<TurnAnchor | null>;
  /** Where the session's backend runs, which is where its Claude transcript is. Absent: the default cwd. */
  spawnCwd?(sessionId: string | null): Promise<string>;
}

export interface TurnTrackingOptions {
  onAccepted?: () => void;
  mutationRelease?: TurnMutationRelease;
  deps?: TurnTrackingDeps;
}

const defaultTurnTrackingDeps: TurnTrackingDeps = {
  getSelection: async (channel, sessionId) => resolveRunSelection({
    channel, session: sessionId ? await sessionStore.getById(sessionId) : null,
  }),
  ledger: conversationLedger,
  anchorEnd: anchorTranscriptEnd,
  spawnCwd: async (sessionId) => sessionSpawnCwd(sessionId ? await sessionStore.getById(sessionId) : null),
};

/** The turn starts where the transcript ends now: no run is writing it while the turn begins. */
async function anchorTurn(
  deps: TurnTrackingDeps,
  backend: string,
  ids: { trackSessionId: string | null; backendSessionId: string | null },
): Promise<TurnAnchor | null> {
  const { backendSessionId } = ids;
  if (!backendSessionId) return null;
  const cwd = backend === 'pi' ? undefined : await deps.spawnCwd?.(ids.trackSessionId);
  return deps.anchorEnd(backend, backendSessionId, cwd);
}

interface TurnTrackingArgs {
  channel: string;
  trackSessionId: string | null;
  backendSessionId: string | null;
  userMessageTs: string;
  userMessageText: string;
  statusMessageTs: string;
}

export type TurnTrackingToken = symbol;

interface TurnTrackingState {
  channel: string;
  operation: Promise<TurnTrackingToken>;
  release: (() => void) | null;
}

const currentTurnTracking = new Map<string, TurnTrackingToken>();
const turnTrackingByToken = new Map<TurnTrackingToken, TurnTrackingState>();
const supersededPendingTurns = new Map<string, TurnTrackingToken>();

export function markPendingTurnSuperseded(channel: string): void {
  const token = currentTurnTracking.get(channel);
  if (token) supersededPendingTurns.set(channel, token);
}

export function consumePendingTurnSupersession(channel: string, token: TurnTrackingToken): boolean {
  if (supersededPendingTurns.get(channel) !== token) return false;
  supersededPendingTurns.delete(channel);
  return true;
}

export function finishTurnTracking(channel: string, token: TurnTrackingToken): void {
  const state = turnTrackingByToken.get(token);
  if (!state || state.channel !== channel) return;
  turnTrackingByToken.delete(token);
  if (currentTurnTracking.get(channel) === token) currentTurnTracking.delete(channel);
  if (supersededPendingTurns.get(channel) === token) supersededPendingTurns.delete(channel);
  state.release?.();
}

export function isTurnTrackingPending(channel: string): boolean {
  return currentTurnTracking.has(channel);
}

export function waitForTurnTracking(channel: string): Promise<void> {
  const token = currentTurnTracking.get(channel);
  const operation = token ? turnTrackingByToken.get(token)?.operation : null;
  return operation ? operation.then(() => undefined) : Promise.resolve();
}

async function runTurnTracking(
  args: TurnTrackingArgs,
  options: TurnTrackingOptions,
  token: TurnTrackingToken,
): Promise<TurnTrackingToken> {
  const release = options.mutationRelease ?? await acquireTurnMutationLock(args.channel);
  try {
    const deps = options.deps ?? defaultTurnTrackingDeps;
    const selection = await deps.getSelection(args.channel, args.trackSessionId);
    const backend = selection.backend;
    const anchor = await anchorTurn(deps, backend, args);
    await deps.ledger.initAndBeginTurn(args.channel, {
      sessionId: args.trackSessionId || null, backend,
      selection, userMessageTs: args.userMessageTs,
      userMessageText: args.userMessageText || '', statusMessageTs: args.statusMessageTs, anchor,
    });
    options.onAccepted?.();
    const state = turnTrackingByToken.get(token);
    if (state) state.release = release;
    return token;
  } catch (error) {
    release();
    throw error;
  }
}

export function initTurnTracking(
  channel: string,
  trackSessionId: string | null,
  backendSessionId: string | null,
  userMessageTs: string,
  userMessageText: string,
  statusMessageTs: string,
  options: TurnTrackingOptions = {},
): Promise<TurnTrackingToken> {
  const token = Symbol(channel);
  const operation = runTurnTracking({
    channel, trackSessionId, backendSessionId,
    userMessageTs, userMessageText, statusMessageTs,
  }, options, token);
  currentTurnTracking.set(channel, token);
  turnTrackingByToken.set(token, { channel, operation, release: null });
  void operation.catch(() => finishTurnTracking(channel, token));
  return operation;
}
