// input:  a turn's channel + session ids + the user message that opened it
// output: the conversation-ledger turn record, its pre-turn backend snapshot, and the per-channel
//         "a turn is being accepted right now" guard the edit/rewind paths wait on
// pos:    orchestration/turn — the ledger half of a turn's bookkeeping, split out of the retired
//         lifecycle.ts so the Turn object (and `turn/active-turns.ts`) can own it.
import type { TurnMutationRelease } from '../turn-mutation-lock.js';
import { acquireTurnMutationLock } from '../turn-mutation-lock.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import * as sessionBackup from '@domain/sessions/session-backup.js';
import { getActiveProfile, resolveBackendForChannel } from '@domain/agents/index.js';

interface TurnTrackingDeps {
  resolveBackend(channel: string): string;
  getProfile(channel: string): string | null;
  ledger: Pick<typeof conversationLedger, 'initAndBeginTurn' | 'setBackupPath'>;
  backup: Pick<typeof sessionBackup, 'findPISessionFile' | 'backupSessionFile' | 'createBackup'>;
}

export interface TurnTrackingOptions {
  onAccepted?: () => void;
  mutationRelease?: TurnMutationRelease;
  deps?: TurnTrackingDeps;
}

const defaultTurnTrackingDeps: TurnTrackingDeps = {
  resolveBackend: resolveBackendForChannel,
  getProfile: getActiveProfile,
  ledger: conversationLedger,
  backup: sessionBackup,
};

async function snapshotTurn(
  deps: TurnTrackingDeps,
  backend: string,
  backendSessionId: string | null,
  turnIndex: number,
): Promise<string | null> {
  if (!backendSessionId) return null;
  if (backend !== 'pi') return deps.backup.createBackup(backendSessionId, turnIndex);
  const piFile = await deps.backup.findPISessionFile(backendSessionId);
  return piFile ? deps.backup.backupSessionFile(piFile, turnIndex) : null;
}

interface TurnTrackingArgs {
  channel: string;
  trackSessionId: string | null;
  backendSessionId: string | null;
  sessionName: string | null;
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
    const backend = deps.resolveBackend(args.channel);
    const { turnIndex } = await deps.ledger.initAndBeginTurn(args.channel, {
      sessionId: args.trackSessionId || null, sessionName: args.sessionName, backend,
      profileName: deps.getProfile(args.channel), userMessageTs: args.userMessageTs,
      userMessageText: args.userMessageText || '', statusMessageTs: args.statusMessageTs,
    });
    const backupPath = await snapshotTurn(deps, backend, args.backendSessionId, turnIndex);
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
  sessionName: string | null,
  userMessageTs: string,
  userMessageText: string,
  statusMessageTs: string,
  options: TurnTrackingOptions = {},
): Promise<TurnTrackingToken> {
  const token = Symbol(channel);
  const operation = runTurnTracking({
    channel, trackSessionId, backendSessionId, sessionName,
    userMessageTs, userMessageText, statusMessageTs,
  }, options, token);
  currentTurnTracking.set(channel, token);
  turnTrackingByToken.set(token, { channel, operation, release: null });
  void operation.catch(() => finishTurnTracking(channel, token));
  return operation;
}
