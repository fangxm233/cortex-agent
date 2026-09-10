// input:  session/history stores, tool metadata, DEBUG policy
// output: session snapshots, transcripts, subagent detail, DEBUG
// pos:    Authoritative query boundary for session transcripts
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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
  TranscriptDelta,
  TranscriptDeltaRow,
  TranscriptDebugDetails,
  SessionsPendingInteractionParams,
  SessionsPendingInteraction,
} from '../types.js';
import { effectiveBackendSessionId } from '@store/session-registry-repo.js';
import type { HistoryEvent } from '@store/conversation-history-repo.js';
import { projectCompactHistory, projectSubagentHistory } from '@store/conversation-display-projection.js';
import { isDebugMode } from '@core/debug-mode.js';

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

  // Live running snapshot: an interactive turn = a non-thread execution registered on the
  // session's channel (threads run their own executions on the same channel and must not
  // mark the session itself running). Snapshot + delta: this field is the queryable snapshot;
  // the `session.status` event stream is the delta.
  const isChannelInTurn = (channel: string | undefined): boolean =>
    !!channel && deps.runningExecutions.getByChannel(channel).some((e) => !e.threadId);

  // Live agent-turn count of the in-flight interactive turn (the running snapshot): the non-thread
  // execution on the channel carries its own live numTurns, updated in-memory on each turn_progress.
  const liveTurnsForChannel = (channel: string | undefined): number | null => {
    if (!channel) return null;
    const exec = deps.runningExecutions.getByChannel(channel).find((e) => !e.threadId);
    return exec && typeof (exec as any).numTurns === 'number' ? (exec as any).numTurns : null;
  };

  // Idle snapshot: the last COMPLETED interactive run's turn count AND total cost. One pass over the
  // execution registry builds channel → latest non-thread execution (by startedAt), carrying both its
  // numTurns and metrics.costUsd (same run). A running turn never falls back to this (avoids showing
  // the previous run's count/cost during a fresh turn). costUsd is only known at turn end — there is
  // no live in-memory cost source — so the running case has no live cost (null).
  const lastRunByChannel = new Map<string, { startedAt: string; numTurns: number; costUsd: number | null }>();
  for (const e of deps.executionRegistry.getAll()) {
    const channel: string | undefined = e?.channel ?? undefined;
    const numTurns: unknown = e?.metrics?.numTurns;
    if (!channel || e?.thread?.threadId || typeof numTurns !== 'number') continue;
    const startedAt: string = e?.runtime?.startedAt ?? '';
    const costUsd: unknown = e?.metrics?.costUsd;
    const prev = lastRunByChannel.get(channel);
    if (!prev || startedAt.localeCompare(prev.startedAt) >= 0) {
      lastRunByChannel.set(channel, { startedAt, numTurns, costUsd: typeof costUsd === 'number' ? costUsd : null });
    }
  }

  // Every row asks the same question — can this session's profile compact? — and the answer is a
  // function of (backend, profileName) alone, of which a list holds a handful. Asking per row made
  // a 300-session list resolve (and revalidate) profiles.json 300 times per request.
  const compactionByProfile = new Map<string, boolean>();
  const supportsCompaction = (session: { backend: string; profileName: string | null }): boolean => {
    if (!deps.supportsSessionCompaction) return false;
    const key = `${session.backend}\u0000${session.profileName ?? ''}`;
    const known = compactionByProfile.get(key);
    if (known !== undefined) return known;
    const supported = deps.supportsSessionCompaction(session);
    compactionByProfile.set(key, supported);
    return supported;
  };

  const resolveNumTurns = (channel: string | undefined, running: boolean): number | null => {
    if (running) return liveTurnsForChannel(channel);
    return channel ? (lastRunByChannel.get(channel)?.numTurns ?? null) : null;
  };
  // Last run's cost: idle → the latest non-thread run's finalized cost; running → null (no live source).
  const resolveCost = (channel: string | undefined, running: boolean): number | null => {
    if (running) return null;
    return channel ? (lastRunByChannel.get(channel)?.costUsd ?? null) : null;
  };

  const infos = sessions.map((s: any): SessionInfo => {
    const inTurn = isChannelInTurn(s.channel);
    // Web bg-hold snapshot: the foreground execution is gone from runningExecutions, but a
    // background task still holds the session (running stays true per the session.status contract).
    // A live foreground turn wins — the session then renders as plain running. Metrics
    // (numTurns/costUsd) key off the foreground turn: a held session shows its last completed run.
    const bgHeld = !inTurn && (deps.isSessionBgHeld?.(s.sessionId) ?? false);
    const running = inTurn || bgHeld;
    // Awaiting user action: the session is blocked on a pending ask-user question or plan approval
    // (keyed by the session's channel). This is the ONLY signal that turns the rail dot amber —
    // running/background stay blue. A non-blocking ask does not stall the session, so it stays
    // blue too. Absent deps (fixtures/TUI) ⇒ false.
    const awaitingInput =
      deps.getPendingAskUser?.(s.channel)?.blocking === true || !!deps.getPendingPlan?.(s.channel);
    return {
      sessionId: s.sessionId,
      // Backend CLI resume target (registry backendSessionId, legacy fallback to sessionId) — the
      // real UUID the "Session ID" surface shows, decoupled from the track sessionId above.
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
      browser: s.browser ?? null,
      contextUsage: s.contextUsage ?? null,
      todos: deps.getSessionTodos?.(s.sessionId) ?? null,
      contextCompactionSupported: supportsCompaction({ backend: s.backend, profileName: s.profileName ?? null }),
      running,
      backgroundRunning: bgHeld,
      awaitingInput,
      numTurns: resolveNumTurns(s.channel, inTurn),
      costUsd: resolveCost(s.channel, inTurn),
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
  // Stamped by the fold from the row's own serialized size; the query trusts it rather than
  // re-weighing the parsed input once per tool row per request.
  const warned = ev.debug.overCharacterThreshold === true;
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

/** Compact history plus the cursor a client passes back as `since`. Stores that cannot produce a
 *  cursor simply do not get deltas — every response stays a full transcript. */
async function compactHistoryAt(deps: UiServiceDeps, sessionId: string) {
  if (deps.conversationHistory.getCompactHistoryAt) {
    return deps.conversationHistory.getCompactHistoryAt(sessionId);
  }
  return { value: await compactHistory(deps, sessionId), cursor: undefined };
}

/** A row whose rendered form depends on wall-clock time or live server state rather than on the
 *  stored history, so its revision cannot say whether it changed. Always re-sent in a delta. */
function isVolatileRow(event: EventWithElapsed): boolean {
  // Only a PENDING interaction is derived: its card can expire on the clock or flip when the
  // server stops holding the question open. Once resolved the row renders from stored fields.
  return event.type === 'interaction' && !!event.id && (event.status ?? 'pending') === 'pending';
}

/**
 * Rows added or changed since `sinceRev`. Walks the whole event stream — `elapsedMs` is a
 * difference against the PREVIOUS row, so the running timestamp has to be carried across rows that
 * are not being sent — but only builds a DTO for the rows it emits, which is the part that costs.
 */
function transcriptDeltaRows(
  deps: UiServiceDeps,
  events: EventWithElapsed[],
  revs: readonly number[],
  sinceRev: number,
): TranscriptDeltaRow[] {
  const changed: TranscriptDeltaRow[] = [];
  let previousMs: number | null = null;
  events.forEach((event, index) => {
    const elapsed = eventElapsedMs(event, previousMs);
    previousMs = nextPreviousMs(event);
    if ((revs[index] ?? 0) <= sinceRev && !isVolatileRow(event)) return;
    changed.push({ index, turnIndex: event.turnIndex, message: messageFromEvent(deps, event, elapsed) });
  });
  return changed;
}

/** `<epoch>:<revision>`; a differing epoch means the session was rewritten and the cursor is void. */
function parseCursor(cursor: string | undefined): { epoch: string; revision: number } | null {
  if (!cursor) return null;
  const at = cursor.lastIndexOf(':');
  if (at <= 0) return null;
  const revision = Number(cursor.slice(at + 1));
  return Number.isSafeInteger(revision) && revision >= 0 ? { epoch: cursor.slice(0, at), revision } : null;
}

function transcriptDelta(
  deps: UiServiceDeps,
  events: EventWithElapsed[],
  revs: readonly number[] | undefined,
  since: string | undefined,
  cursor: string | undefined,
): TranscriptDelta | null {
  const from = parseCursor(since);
  const now = parseCursor(cursor);
  if (!from || !now || !revs || from.epoch !== now.epoch || from.revision > now.revision) return null;
  return { changed: transcriptDeltaRows(deps, events, revs, from.revision), total: events.length };
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
  const { value: history, cursor } = await compactHistoryAt(deps, params.sessionId);
  const events = history?.events ?? [];
  const pendingUserMessages = pendingMessages(pendingSnapshot, history?.committedSourceIds);
  const subagentSummaries = history?.subagentSummaries ?? [];
  // Pending messages and subagent summaries are per-session, not per-row, and small: they ride
  // every response whole, so a delta only ever has to describe transcript ROWS.
  const delta = cursor === undefined
    ? null
    : transcriptDelta(deps, events, history?.eventRevs, params.since, cursor);
  // Built only when it is going to be sent — assembling every row's DTO is the server-side cost a
  // delta exists to avoid, so the whole-transcript path must not run underneath it.
  if (delta) return { sessionId: params.sessionId, turns: [], pendingUserMessages, subagentSummaries, cursor, delta };
  const base = sessionTranscript(deps, params.sessionId, events, pendingUserMessages, subagentSummaries);
  return cursor === undefined ? base : { ...base, cursor };
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
  // The store stamps `overCharacterThreshold` while it reads the rows, so there is nothing left
  // to derive here.
  return await deps.conversationHistory.getToolDebugDetails(params.sessionId, params.ref);
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
