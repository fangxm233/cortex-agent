import type { TurnMutationRelease } from '../turn-mutation-lock.js';
import { acquireTurnMutationLock } from '../turn-mutation-lock.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import * as sessionBackup from '@domain/sessions/session-backup.js';
import { resolveRunSelection } from '@domain/runs/config-resolver.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { sessionSpawnCwd } from '@core/paths.js';
import type { EngineSelection } from '@domain/agents/engine-selection.js';

interface TurnTrackingDeps {
  getSelection(channel: string, sessionId: string | null): EngineSelection | Promise<EngineSelection>;
  ledger: Pick<typeof conversationLedger, 'initAndBeginTurn' | 'setBackupPath'>;
  backup: Pick<typeof sessionBackup, 'findPISessionFile' | 'backupSessionFile' | 'createBackup'>;
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
  backup: sessionBackup,
  spawnCwd: async (sessionId) => sessionSpawnCwd(sessionId ? await sessionStore.getById(sessionId) : null),
};

async function snapshotTurn(
  deps: TurnTrackingDeps,
  backend: string,
  ids: { trackSessionId: string | null; backendSessionId: string | null },
  turnIndex: number,
): Promise<string | null> {
  const { backendSessionId } = ids;
  if (!backendSessionId) return null;
  if (backend !== 'pi') {
    const cwd = await deps.spawnCwd?.(ids.trackSessionId);
    return deps.backup.createBackup(backendSessionId, turnIndex, cwd);
  }
  const piFile = await deps.backup.findPISessionFile(backendSessionId);
  return piFile ? deps.backup.backupSessionFile(piFile, turnIndex) : null;
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
    const { turnIndex } = await deps.ledger.initAndBeginTurn(args.channel, {
      sessionId: args.trackSessionId || null, backend,
      selection, userMessageTs: args.userMessageTs,
      userMessageText: args.userMessageText || '', statusMessageTs: args.statusMessageTs,
    });
    const backupPath = await snapshotTurn(deps, backend, args, turnIndex);
    if (backupPath) await deps.ledger.setBackupPath(args.channel, args.userMessageTs, backupPath);
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
