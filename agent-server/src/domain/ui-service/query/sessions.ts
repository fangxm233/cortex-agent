import type {
  UiServiceDeps,
  SessionInfo,
  SessionsListParams,
  SessionsTranscriptParams,
  SessionsSubagentTranscriptParams,
  SessionsDebugDetailsParams,
  SessionTranscript,
  SessionSubagentTranscript,
  TranscriptTurn,
  TranscriptMessage,
  TranscriptDebugDetails,
  SessionsPendingInteractionParams,
  SessionsPendingInteraction,
} from '../types.js';
import { effectiveBackendSessionId } from '@store/session-registry-repo.js';
import { sessionTotalsCarry } from '@store/session-totals-repo.js';
import {
  addTotalsAcc, emptyTotalsAcc, foldExecution, toSessionTotals,
  type SessionTotalsAcc,
} from '@store/session-totals.js';
import type { HistoryEvent } from '@store/conversation-history-repo.js';
import { projectCompactHistory, projectSubagentHistory } from '@store/conversation-display-projection.js';
import { isDebugMode, isDebugToolOverWarningThreshold } from '@core/debug-mode.js';

export async function handleSessionsList(
  deps: UiServiceDeps,
  params: SessionsListParams,
): Promise<SessionInfo[]> {
  const { projectId, resumable, origin } = params;

  let sessions: any[];
  if (origin) {
    // Origin filter takes precedence: the workbench left rail passes origin='direct' so only
    // user conversations show (thread/scheduled sessions live in their own views).
    sessions = await deps.sessionStore.listByOrigin(origin, projectId);
  } else if (resumable) {
    sessions = await deps.sessionStore.listResumable(projectId);
  } else if (projectId) {
    sessions = await deps.sessionStore.listByProject(projectId);
  } else {
    // list all — iterate through listByProject for each known project
    // or fall back to listing all sessions via the store
    const allProjects = deps.projectStore.list();
    const results: any[] = [];
    for (const p of allProjects) {
      const projectSessions = await deps.sessionStore.listByProject(p.id);
      results.push(...projectSessions);
    }
    sessions = results;
  }

  // Idle snapshot: the last COMPLETED interactive run's turn count AND total cost. One pass over the
  // execution registry builds SESSION ID → latest execution belonging to that session (by startedAt),
  // carrying both its numTurns and metrics.costUsd (same run). A running turn never falls back to this
  // (avoids showing the previous run's count/cost during a fresh turn). costUsd is only known at turn
  // end — there is no live in-memory cost source — so the running case has no live cost (null).
  //
  // Keyed by `session.sessionId`, NOT by channel: a subagent run (`source.trigger === 'subagent'`)
  // inherits its parent's channel while carrying no track identity (`session.sessionId === null`), and
  // a child always STARTS AFTER the parent run that spawned it. Keying by channel + max(startedAt)
  // therefore let any subagent shadow the session's own run — the session card reported that child's
  // turns and cost (e.g. `52 turns · $1.95`) instead of the session's (`300 turns · $32.51`). Keying by
  // session id drops those children (null id) for free, and also stops a recycled channel from
  // attributing an older session's run to the session now sitting on that channel.
  //
  // The SAME pass also rolls up whole-session totals (`SessionInfo.totals`) — the cumulative
  // counterpart of the last-run numbers above. The two answer different questions and neither
  // replaces the other: the last run is "what did that answer cost", the totals are "what has this
  // conversation cost". Folding rules live in @store/session-totals.js; the archive carry read
  // below supplies the runs that have already left this registry.
  const carry = await sessionTotalsCarry.read().catch(() => null);
  const totalsBySession = new Map<string, SessionTotalsAcc>();
  const lastRunBySession = new Map<string, { startedAt: string; numTurns: number; costUsd: number | null }>();
  for (const e of deps.executionRegistry.getAll()) {
    foldExecution(totalsBySession, e, carry?.carriedThrough ?? null);
    const runSessionId: string | undefined = e?.session?.sessionId ?? undefined;
    const numTurns: unknown = e?.metrics?.numTurns;
    if (!runSessionId || e?.thread?.threadId || typeof numTurns !== 'number') continue;
    const startedAt: string = e?.runtime?.startedAt ?? '';
    const costUsd: unknown = e?.metrics?.costUsd;
    const prev = lastRunBySession.get(runSessionId);
    if (!prev || startedAt.localeCompare(prev.startedAt) >= 0) {
      lastRunBySession.set(runSessionId, { startedAt, numTurns, costUsd: typeof costUsd === 'number' ? costUsd : null });
    }
  }
  for (const [sessionId, carried] of Object.entries<SessionTotalsAcc>(carry?.sessions ?? {})) {
    const live = totalsBySession.get(sessionId);
    totalsBySession.set(sessionId, addTotalsAcc(live ?? emptyTotalsAcc(), carried));
  }
  const resolveNumTurns = (
    sessionId: string | undefined,
    inTurn: boolean,
    liveNumTurns: number | null,
  ): number | null => {
    if (inTurn) return liveNumTurns;
    return sessionId ? (lastRunBySession.get(sessionId)?.numTurns ?? null) : null;
  };
  // Last run's cost: idle → this session's latest non-thread run's finalized cost; running → null
  // (no live source).
  const resolveCost = (sessionId: string | undefined, running: boolean): number | null => {
    if (running) return null;
    return sessionId ? (lastRunBySession.get(sessionId)?.costUsd ?? null) : null;
  };

  const infos = sessions.map((s: any): SessionInfo => {
    // Busy snapshot: the registry's single answer for this session. Snapshot + delta — this field
    // is the queryable snapshot, the `session.status` event stream is the delta.
    const state = deps.runningExecutions.sessionState(s.sessionId);
    // Foreground turn = a live non-thread execution belonging to THIS session (threads run beside
    // their parent and never make the session itself busy). Keyed off the session's id, not its
    // CHANNEL, so a session switch does not leave the old record looking busy while the NEW session
    // on that channel runs.
    const inTurn = state.executionId !== null;
    // Web bg-hold snapshot: the foreground execution is gone from the live-run registry, but a
    // background task still holds the session (running stays true per the session.status contract).
    // A live foreground turn wins — the session then renders as plain running. Metrics
    // (numTurns/costUsd) key off the foreground turn: a held session shows its last completed run.
    const bgHeld = !inTurn && state.backgroundRunning;
    const running = inTurn || bgHeld;   // identical to state.running
    // Awaiting user action: the session is blocked on a pending ask-user question or plan approval
    // (keyed by the session's channel). This is the ONLY signal that turns the rail dot amber —
    // running/background stay blue. A non-blocking ask does not stall the session, so it stays
    // blue too. Absent deps (fixtures/TUI) ⇒ false.
    const awaitingInput =
      deps.getPendingAskUser?.(s.channel)?.blocking === true || !!deps.getPendingPlan?.(s.channel);
    return {
      sessionId: s.sessionId,
      // Backend CLI resume target (the registry's `backendSessionId` snapshot, falling back to the
      // session record's own) — the real UUID the "Session ID" surface shows, decoupled from the
      // track sessionId above.
      backendSessionId: effectiveBackendSessionId(s),
      name: s.name,
      projectId: s.projectId,
      backend: s.backend,
      kind: s.kind,
      origin: s.origin ?? 'direct',
      scheduleId: s.scheduleId ?? null,
      commissionId: s.commissionId ?? null,
      commissionDraft: s.commissionDraft ?? null,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      resumable: s.kind !== 'scheduled',
      label: s.label ?? null,
      profileName: s.profileName ?? null,
      // The other half of "what will the next turn run": the profile alone would misreport every
      // session whose model or thinking level the user picked in the composer.
      selectionOverride: deps.getChannelSelectionOverride?.(s.channel) ?? null,
      browser: s.browser ?? null,
      contextUsage: s.contextUsage ?? null,
      todos: deps.getSessionTodos?.(s.sessionId) ?? null,
      contextCompactionSupported: deps.supportsSessionCompaction?.(s) ?? false,
      running,
      backgroundRunning: bgHeld,
      awaitingInput,
      numTurns: resolveNumTurns(s.sessionId, inTurn, state.numTurns),
      costUsd: resolveCost(s.sessionId, inTurn),
      // Cumulative over every finished run this session has had (plus its Agent-tool children's
      // spend). Unaffected by `running`: an in-flight turn is simply not in it yet.
      totals: toSessionTotals(totalsBySession.get(s.sessionId)),
      // Unread = activity (lastUsedAt, bumped at turn end) after the user's last view
      // (sessions.markRead → lastReadAt). Legacy DIRECT records without lastReadAt → read
      // (no unread flood on first deploy). SCHEDULED runs invert the default: a run the user
      // never opened IS the unread state (27c result → blue dot until opened).
      unread: s.origin === 'scheduled'
        ? (!s.lastReadAt || s.lastUsedAt > s.lastReadAt)
        : (!!s.lastReadAt && s.lastUsedAt > s.lastReadAt),
    };
  });

  // Title label-less sessions from their first user message so the left rail shows the conversation's
  // opening text instead of the opaque `cortex-XXXX` name. Read-only + bounded (only for sessions
  // with no persisted label, capped) so a large unscoped list stays cheap; new sessions already get a
  // persisted label at their first turn (agent-runner.ensureSessionLabel).
  const getFirstUserText = deps.conversationHistory.getFirstUserText;
  if (getFirstUserText) {
    const LABEL_DERIVE_CAP = 80;
    let derived = 0;
    for (const info of infos) {
      if (derived >= LABEL_DERIVE_CAP) break;
      if (info.label && info.label.trim()) continue;
      derived++;
      const first = await getFirstUserText(info.sessionId).catch(() => null);
      if (first) info.label = first.length > 60 ? first.slice(0, 60) : first;
    }
  }

  return infos;
}

// ── sessions.transcript (S4 chat) ─────────────────────────────────
// Wrap the backend-independent conversation history and group its already-turn-tagged event
// stream into turns. An absent/empty history is not an error — it maps to zero turns.

/** Pending interactions older than this derive to expired at read time (matches the
 *  hook-bridge / ask-user 30-minute TTLs). */
const INTERACTION_TTL_MS = 30 * 60 * 1000;

function transcriptDebugDetails(ev: HistoryEvent): TranscriptMessage['debug'] {
  if (!isDebugMode() || ev.debug === undefined) return undefined;
  if (ev.type !== 'tool') return ev.debug;
  const warned = ev.debug.overCharacterThreshold === true
    || isDebugToolOverWarningThreshold(ev.debug);
  if (!ev.debug.toolRef && !warned) return undefined;
  return {
    ...(ev.debug.toolRef ? { toolRef: ev.debug.toolRef } : {}),
    ...(warned ? { overCharacterThreshold: true } : {}),
  };
}

/** Legacy-compatible subtype derived from kind+status (old clients render InteractionRow off it). */
function interactionSubtype(kind: string, status: string): string {
  if (kind === 'plan-approval') return status === 'approved' ? 'plan-approved' : status === 'rejected' ? 'plan-rejected' : `plan-${status}`;
  return status === 'answered' ? 'ask-user-answered' : `ask-user-${status}`;
}

async function pendingUserSnapshot(
  deps: UiServiceDeps,
  sessionId: string,
): Promise<NonNullable<SessionTranscript['pendingUserMessages']>> {
  const records = await deps.pendingInjections?.listBySession(sessionId) ?? [];
  return records.map((record) => ({
    id: record.id,
    text: record.text,
    ts: record.createdAt,
    ...(record.attachments ? { attachments: record.attachments } : {}),
    ...(record.systemOrigin ? { systemOrigin: record.systemOrigin } : {}),
  }));
}

type EventWithElapsed = HistoryEvent & { elapsedMs?: number | null };

function eventElapsedMs(event: EventWithElapsed, previousMs: number | null): number | null {
  if (event.elapsedMs !== undefined) return event.elapsedMs;
  const currentMs = Date.parse(event.ts);
  return previousMs !== null && Number.isFinite(currentMs) ? currentMs - previousMs : null;
}

function nextPreviousMs(event: EventWithElapsed): number | null {
  const currentMs = Date.parse(event.ts);
  return Number.isFinite(currentMs) ? currentMs : null;
}

function interactionParts(deps: UiServiceDeps, event: EventWithElapsed) {
  if (event.type !== 'interaction' || !event.id) return { interaction: undefined, subtype: event.subtype };
  const currentMs = Date.parse(event.ts);
  const live = deps.isInteractionPending?.(event.id) ?? false;
  const age = Number.isFinite(currentMs) ? Date.now() - currentMs : Infinity;
  const status = event.status === 'pending' && (!live || age > INTERACTION_TTL_MS)
    ? 'expired'
    : (event.status ?? 'pending');
  return {
    interaction: {
      id: event.id,
      kind: (event.kind ?? 'ask-user') as NonNullable<TranscriptMessage['interaction']>['kind'],
      status: status as NonNullable<TranscriptMessage['interaction']>['status'],
      payload: event.payload ?? {},
      ...(event.result !== undefined ? { result: event.result } : {}),
      ...(event.resolvedVia !== undefined ? { resolvedVia: event.resolvedVia } : {}),
    },
    subtype: interactionSubtype(event.kind ?? 'ask-user', status),
  };
}

function messageFromEvent(
  deps: UiServiceDeps,
  event: EventWithElapsed,
  elapsedMs: number | null,
): TranscriptMessage {
  const { interaction, subtype } = interactionParts(deps, event);
  const debug = transcriptDebugDetails(event);
  return {
    type: event.type as TranscriptMessage['type'],
    text: event.type === 'tool' ? null : (event.text ?? ''),
    toolName: event.type === 'tool' ? (event.toolName ?? '') : null,
    toolInput: event.type === 'tool' ? (event.toolInput ?? '') : null,
    ...(event.type === 'tool' && event.toolDevice ? { toolDevice: event.toolDevice } : {}),
    ts: event.ts,
    elapsedMs,
    ...((event.type === 'user' || event.type === 'assistant') && event.attachments !== undefined ? { attachments: event.attachments } : {}),
    ...(event.type === 'user' && event.systemOrigin !== undefined ? { systemOrigin: event.systemOrigin } : {}),
    ...(event.type === 'assistant' && event.decisions !== undefined ? { decisions: event.decisions } : {}),
    ...(event.type === 'assistant' && event.noticeLevel !== undefined ? { noticeLevel: event.noticeLevel } : {}),
    ...(event.type === 'assistant' && event.noticeAction !== undefined ? { noticeAction: event.noticeAction } : {}),
    ...(event.type === 'user' && event.edited !== undefined ? { edited: event.edited } : {}),
    ...(debug !== undefined ? { debug } : {}),
    ...(event.type === 'interaction' && subtype ? { subtype } : {}),
    ...(interaction !== undefined ? { interaction } : {}),
    ...(event.subagentId !== undefined ? { subagentId: event.subagentId } : {}),
    ...(event.subagentSpawns !== undefined ? { subagentSpawns: event.subagentSpawns } : {}),
    ...(event.subagentType !== undefined ? { subagentType: event.subagentType } : {}),
    ...(event.subagentDescription !== undefined ? { subagentDescription: event.subagentDescription } : {}),
    ...(event.subagentModel !== undefined ? { subagentModel: event.subagentModel } : {}),
  };
}

function transcriptTurns(deps: UiServiceDeps, events: EventWithElapsed[]): TranscriptTurn[] {
  const byTurn = new Map<number, TranscriptTurn>();
  const order: number[] = [];
  let previousMs: number | null = null;
  for (const event of events) {
    const turn = byTurn.get(event.turnIndex) ?? { turnIndex: event.turnIndex, messages: [] };
    if (!byTurn.has(event.turnIndex)) {
      byTurn.set(event.turnIndex, turn);
      order.push(event.turnIndex);
    }
    turn.messages.push(messageFromEvent(deps, event, eventElapsedMs(event, previousMs)));
    previousMs = nextPreviousMs(event);
  }
  return order.map((index) => byTurn.get(index)!);
}

function transcriptMessages(deps: UiServiceDeps, events: EventWithElapsed[]): TranscriptMessage[] {
  let previousMs: number | null = null;
  return events.map((event) => {
    const message = messageFromEvent(deps, event, eventElapsedMs(event, previousMs));
    previousMs = nextPreviousMs(event);
    return message;
  });
}

function pendingMessages(
  snapshot: NonNullable<SessionTranscript['pendingUserMessages']>,
  committedSourceIds: string[] | undefined,
) {
  const committed = new Set(committedSourceIds ?? []);
  return snapshot.filter((message) => !committed.has(message.id));
}

async function compactHistory(deps: UiServiceDeps, sessionId: string) {
  if (deps.conversationHistory.getCompactHistory) return deps.conversationHistory.getCompactHistory(sessionId);
  const history = await deps.conversationHistory.getHistory(sessionId, { includeToolDebug: false });
  return history ? projectCompactHistory(history) : null;
}

async function subagentHistory(deps: UiServiceDeps, sessionId: string, subagentId: string) {
  if (deps.conversationHistory.getSubagentHistory) {
    return deps.conversationHistory.getSubagentHistory(sessionId, subagentId);
  }
  return projectSubagentHistory(
    await deps.conversationHistory.getHistory(sessionId, { includeToolDebug: false }),
    subagentId,
  );
}

function sessionTranscript(
  deps: UiServiceDeps,
  sessionId: string,
  events: EventWithElapsed[],
  pendingUserMessages: NonNullable<SessionTranscript['pendingUserMessages']>,
  subagentSummaries?: SessionTranscript['subagentSummaries'],
): SessionTranscript {
  return {
    sessionId,
    turns: transcriptTurns(deps, events),
    pendingUserMessages,
    ...(subagentSummaries !== undefined ? { subagentSummaries } : {}),
  };
}

async function fullTranscript(
  deps: UiServiceDeps,
  params: SessionsTranscriptParams,
  pendingSnapshot: NonNullable<SessionTranscript['pendingUserMessages']>,
): Promise<SessionTranscript> {
  const history = await deps.conversationHistory.getHistory(params.sessionId, { includeToolDebug: false });
  return sessionTranscript(
    deps,
    params.sessionId,
    history?.events ?? [],
    pendingMessages(pendingSnapshot, history?.committedSourceIds),
  );
}

async function compactTranscript(
  deps: UiServiceDeps,
  params: SessionsTranscriptParams,
  pendingSnapshot: NonNullable<SessionTranscript['pendingUserMessages']>,
): Promise<SessionTranscript> {
  const history = await compactHistory(deps, params.sessionId);
  return sessionTranscript(
    deps,
    params.sessionId,
    history?.events ?? [],
    pendingMessages(pendingSnapshot, history?.committedSourceIds),
    history?.subagentSummaries ?? [],
  );
}

export async function handleSessionsTranscript(
  deps: UiServiceDeps,
  params: SessionsTranscriptParams,
): Promise<SessionTranscript> {
  const pendingSnapshot = await pendingUserSnapshot(deps, params.sessionId);
  return params.compactSubagents
    ? compactTranscript(deps, params, pendingSnapshot)
    : fullTranscript(deps, params, pendingSnapshot);
}

export async function handleSessionsSubagentTranscript(
  deps: UiServiceDeps,
  params: SessionsSubagentTranscriptParams,
): Promise<SessionSubagentTranscript> {
  const history = await subagentHistory(deps, params.sessionId, params.subagentId);
  return {
    sessionId: params.sessionId,
    subagentId: params.subagentId,
    messages: transcriptMessages(deps, history.events),
  };
}

export async function handleSessionsDebugDetails(
  deps: UiServiceDeps,
  params: SessionsDebugDetailsParams,
): Promise<TranscriptDebugDetails | null> {
  if (!isDebugMode() || !deps.conversationHistory.getToolDebugDetails) return null;
  const details = await deps.conversationHistory.getToolDebugDetails(params.sessionId, params.ref);
  if (!details) return null;
  if (!isDebugToolOverWarningThreshold(details)) return details;
  return { ...details, overCharacterThreshold: true };
}

// ── sessions.pendingInteraction ───────────────────────────────────
// Returns the current pending ask-user or plan approval for a session, if any.
// Reads from the server's in-memory Maps (same lifetime as the blocked MCP tool).
export async function handleSessionsPendingInteraction(
  deps: UiServiceDeps,
  params: SessionsPendingInteractionParams,
): Promise<SessionsPendingInteraction> {
  const channel = `web:${params.sessionId}`;
  return {
    askUser: deps.getPendingAskUser?.(channel) ?? null,
    plan: deps.getPendingPlan?.(channel) ?? null,
  };
}
