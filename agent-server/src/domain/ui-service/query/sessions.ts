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

  const infos = sessions.map((s: any): SessionInfo => ({
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
  }));

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
      attachments: ev.type === 'user' ? ev.attachments : undefined,
    });
    prevMs = curValid ? curMs : null;
  }

  return { sessionId: history.sessionId, turns: order.map((i) => byTurn.get(i)!) };
}
