// input:  UiServiceDeps + SessionsListParams / SessionsTranscriptParams
// output: handleSessionsList → SessionInfo[]; handleSessionsTranscript → SessionTranscript
// pos:    query handlers for 'sessions.list' and 'sessions.transcript'

import type {
  UiServiceDeps,
  SessionInfo,
  SessionsListParams,
  SessionsTranscriptParams,
  SessionTranscript,
  TranscriptTurn,
} from '../types.js';

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

  // Idle snapshot: the last COMPLETED interactive run's turn count. One pass over the execution
  // registry builds channel → latest non-thread execution's numTurns (by startedAt). A running turn
  // never falls back to this (avoids showing the previous run's count during a fresh turn).
  const lastTurnsByChannel = new Map<string, { startedAt: string; numTurns: number }>();
  for (const e of deps.executionRegistry.getAll()) {
    const channel: string | undefined = e?.channel ?? undefined;
    const numTurns: unknown = e?.metrics?.numTurns;
    if (!channel || e?.thread?.threadId || typeof numTurns !== 'number') continue;
    const startedAt: string = e?.runtime?.startedAt ?? '';
    const prev = lastTurnsByChannel.get(channel);
    if (!prev || startedAt.localeCompare(prev.startedAt) >= 0) {
      lastTurnsByChannel.set(channel, { startedAt, numTurns });
    }
  }
  const resolveNumTurns = (channel: string | undefined, running: boolean): number | null => {
    if (running) return liveTurnsForChannel(channel);
    return channel ? (lastTurnsByChannel.get(channel)?.numTurns ?? null) : null;
  };

  const infos = sessions.map((s: any): SessionInfo => {
    const running = isChannelInTurn(s.channel);
    return {
      sessionId: s.sessionId,
      name: s.name,
      projectId: s.projectId,
      backend: s.backend,
      kind: s.kind,
      origin: s.origin ?? 'direct',
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      resumable: s.kind !== 'scheduled',
      label: s.label ?? null,
      profileName: s.profileName ?? null,
      running,
      numTurns: resolveNumTurns(s.channel, running),
      // Unread = activity (lastUsedAt, bumped at turn end) after the user's last view
      // (sessions.markRead → lastReadAt). Legacy records without lastReadAt → read.
      unread: !!s.lastReadAt && s.lastUsedAt > s.lastReadAt,
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
export async function handleSessionsTranscript(
  deps: UiServiceDeps,
  params: SessionsTranscriptParams,
): Promise<SessionTranscript> {
  const history = await deps.conversationHistory.getHistory(params.sessionId);
  if (!history) return { sessionId: params.sessionId, turns: [] };

  const byTurn = new Map<number, TranscriptTurn>();
  const order: number[] = [];
  // Real per-message elapsed: delta from the previous event in the flat chronological stream
  // (history.events is already chronological). First message → null; either ts unparseable → null.
  let prevMs: number | null = null;
  for (const ev of history.events) {
    let turn = byTurn.get(ev.turnIndex);
    if (!turn) {
      turn = { turnIndex: ev.turnIndex, messages: [] };
      byTurn.set(ev.turnIndex, turn);
      order.push(ev.turnIndex);
    }
    const curMs = Date.parse(ev.ts);
    const curValid = Number.isFinite(curMs);
    const elapsedMs = prevMs !== null && curValid ? curMs - prevMs : null;
    turn.messages.push({
      type: ev.type,
      text: ev.type === 'tool' ? null : (ev.text ?? ''),
      toolName: ev.type === 'tool' ? (ev.toolName ?? '') : null,
      toolInput: ev.type === 'tool' ? (ev.toolInput ?? '') : null,
      ts: ev.ts,
      elapsedMs,
      // Only materialize the key when present — an explicit `attachments: undefined` breaks
      // deep-equality with the DTO shape (pre-existing red test, fixed in passing).
      ...(ev.type === 'user' && ev.attachments !== undefined ? { attachments: ev.attachments } : {}),
    });
    prevMs = curValid ? curMs : null;
  }

  return { sessionId: history.sessionId, turns: order.map((i) => byTurn.get(i)!) };
}
