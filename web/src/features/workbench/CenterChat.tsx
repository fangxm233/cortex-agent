import { useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang, useVocab } from '@/i18n';
import { ChatHeader } from './ChatHeader';
import { MessageStream, type MessageEditCtx } from './MessageStream';
import { InlineThreadCardProto } from './InlineThreadCardProto';
import { Composer } from './Composer';
import { ContextUsageControl } from './ContextUsageControl';
import { useSessionCompact } from './useSessionCompact';
import { invalidateActiveSubagentTranscriptQueries, useSessionMessageLiveSync } from './useSessionMessageLiveSync';
import { useSessionWaitpoints } from './useSessionWaitpoints';
import { useInteractionActions } from './useInteractionActions';
import { useMarkSessionRead } from './useMarkSessionRead';
import { buildTranscriptRows, turnCount, resolveTurns, currentTurnElapsedMs, formatElapsed, formatDividerFromVocab } from './transcript-vm';
import { sessionSpanMs } from './session-stats';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useSelectedSession } from './SelectedSessionProvider';
import { useOptimisticUserMessages } from './useOptimisticUserMessages';
import { scheduledRunTitle } from './schedule-rail';
import { useProjectSessions } from '@/features/projects/useProjectSessions';
import { CommissionBanner } from '@/features/commission/CommissionBanner';
import { useSessionCommission } from './CommissionOptIn';

// CENTER CHAT pane — 1:1 rebuild from prototype.dc.html L103–395 (workspace-chat view). Task aba0
// (S4 chat) makes the transcript body + composer send REAL, replacing 89e7's GAP-A (static transcript)
// and GAP-C (inert send) placeholders:
//   • transcript: real `sessions.transcript` query (grouped turns) → prototype message rows
//   • streaming: live `session.message` subscription appends assistant/tool output as it lands, and
//     invalidates the transcript so the finalized history reconciles (buildTranscriptRows de-dups).
//     The block being written is handed to the stream as `streamKey`-scoped preview text, which the
//     stream reveals at a steady rate instead of a delta at a time; the key is the session, so
//     switching sessions mid-reply settles the reveal rather than carrying it into the next chat
//   • send: the composer routes each message through the real `sessions.send` mutate; the reply echoes
//     back over the same live stream (fire-and-forget)
// Running is snapshot + delta: SessionInfo.running (sessions.list) restores the true state on
// mount / session switch / reload, and the live `session.status` event overrides once received —
// so a mid-turn session never shows idle after switching away and back. The one other live surface
// (inline thread card, threads.get) is kept.

const EMPTY_TRANSCRIPT = { sessionId: '', turns: [] };

// The brand mark (25c 皮层弧 C), tinted for the transcript rather than the rail badge.
function DraftBrandMark(): JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <circle cx={33} cy={32} r={6} fill="var(--proto-ink)" />
      <path d="M42.29 23.64A12.5 12.5 0 1 0 42.29 40.36" stroke="var(--proto-accent)" strokeWidth={6} strokeLinecap="round" />
      <path d="M48.6 17.95A21 21 0 1 0 48.6 46.05" stroke="var(--proto-accent)" strokeWidth={6} strokeLinecap="round" />
    </svg>
  );
}

// Fills the transcript area of a draft, where there is nothing to read yet.
/** "in {project} · sends on first message" — the project keeps full ink so it reads as the answer
 *  to "where will this land?", which is the only thing the draft state has to say. */
function DraftSubtitle({ projectName }: { projectName: string | null }): JSX.Element | null {
  const L = useVocab();
  if (!projectName) return null;
  const [before, after] = L.wbDraftIn.split('{p}');
  return (
    <div style={{ fontSize: 12 }}>
      {before}
      <span style={{ color: 'var(--proto-ink)', fontWeight: 600 }}>{projectName}</span>
      {after}
      {' · '}
      {L.wbDraftSendsOnFirst}
    </div>
  );
}

function DraftHero({ title, projectName }: { title: string; projectName: string | null }): JSX.Element {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        color: 'var(--proto-muted-2)',
        animation: 'cxfade .3s ease',
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 14,
          background: 'var(--glass-2)',
          boxShadow: 'var(--shadow-card), 0 0 0 1px var(--proto-line)',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <DraftBrandMark />
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--proto-ink)' }}>{title}</div>
      <DraftSubtitle projectName={projectName} />
    </div>
  );
}

// `grow` is the pane's share of the fluid center region — 1 normally, `1 - split` while a preview
// is pinned beside the chat (WorkbenchPage owns the split).
export function CenterChat({ grow = 1, onOpenSettings }: {
  grow?: number;
  onOpenSettings?: () => void;
} = {}): JSX.Element {
  const L = useVocab();
  const lang = useLang();
  const trpc = useTRPC();
  const chatDropTargetRef = useRef<HTMLDivElement>(null);
  const { currentProjectId } = useCurrentProject();
  const { selectedSessionId, isDraft, draftSelection, draftReloadToken } = useSelectedSession();
  // Scoped to the current project (dedupes with the LeftRail / provider query) so the active session
  // is resolved from the same lists the rail shows — direct conversations AND scheduled runs
  // (design 27a-B puts both in the rail, so both must open here).
  const sessionsQuery = useProjectSessions(currentProjectId, 'direct');
  const scheduledSessionsQuery = useProjectSessions(currentProjectId, 'scheduled');

  // The active session is the shared cross-pane selection (a LeftRail click), resolved against the
  // scoped lists. No local most-recent computation — selection is the single source of truth.
  const active = useMemo(() => {
    const list = [...(sessionsQuery.data ?? []), ...(scheduledSessionsQuery.data ?? [])];
    return list.find((s) => s.sessionId === selectedSessionId) ?? null;
  }, [sessionsQuery.data, scheduledSessionsQuery.data, selectedSessionId]);

  // Commission mode is invisible in the transcript, so the composer keeps a capsule saying which
  // commission this session serves — read-only, because the choice was made when it was created.
  const sessionCommission = useSessionCommission(active);

  // Schedule context (design 30c): the chat is identical to a normal conversation — the only
  // scheduled affordances left are the title annotation「schedule 名 · run #n」on an un-adopted
  // run and the reply-adopts hint under the composer. Management lives in the rail/modal.
  const schedulesQuery = useQuery({
    ...trpc.schedules.list.queryOptions({}),
    enabled: !!active?.scheduleId,
  });
  const activeSchedule = useMemo(
    () => (active?.scheduleId ? (schedulesQuery.data ?? []).find((s) => s.id === active.scheduleId) ?? null : null),
    [schedulesQuery.data, active?.scheduleId],
  );
  // Un-adopted scheduled run: the composer carries the "replying converts this run" hint (30c).
  const isScheduledRun = active?.origin === 'scheduled';
  // 30c title:「schedule 名 · run #n」for an un-adopted run (falls back to the plain label when
  // the schedule record is gone; adopted sessions are plain timeline rows).
  const runTitle = useMemo(() => {
    if (!isScheduledRun || !active?.scheduleId) return null;
    const runs = (scheduledSessionsQuery.data ?? []).filter((s) => s.scheduleId === active.scheduleId);
    return scheduledRunTitle(activeSchedule, runs, active.sessionId);
  }, [isScheduledRun, active?.scheduleId, active?.sessionId, activeSchedule, scheduledSessionsQuery.data]);

  const sessionId = active?.sessionId ?? (isDraft ? '' : selectedSessionId ?? '');
  const title = isDraft
    ? L.wbNewConversation
    : active
      ? runTitle ?? active.label ?? active.name
      : 'No session';

  const transcriptQuery = useQuery({
    ...trpc.sessions.transcript.queryOptions({ sessionId, compactSubagents: true }),
    enabled: !!sessionId,
  });

  // `deltas: true` — this is the surface that shows a live preview, so it opens the session-scoped
  // delta subscription. The reply then appears token by token instead of arriving whole after the
  // whole block is generated (measured on a long answer: first text at ~3.6s, complete at ~22s).
  // `transcript` is passed back in only so a pending row self-heals if its delivered event is lost.
  const {
    liveTail, getMessageSnapshot, streaming, running, backgroundRunning,
    liveTurns, contextUsage, todos, streamingText, pendingUser,
  } = useSessionMessageLiveSync(sessionId, active?.running, active?.backgroundRunning, {
      deltas: true,
      transcript: transcriptQuery.data ?? null,
      contextUsage: active?.contextUsage ?? null,
      todos: active?.todos ?? null,
    });
  // Waitpoints for the rail above the composer. Kept here rather than inside WaitRail so mounting a
  // composer in a test does not require the waitpoints route to be stubbed.
  const waitpoints = useSessionWaitpoints(isDraft ? null : sessionId, active?.waitingOn ?? 0);
  const optimistic = useOptimisticUserMessages({
    sessionId,
    isDraft,
    projectId: currentProjectId ?? 'general',
    transcript: transcriptQuery.data ?? null,
    liveTail,
    pendingUser,
    getMessageSnapshot,
  });
  // Interaction cards are transcript rows now (web-interactions-redesign) — this hook only
  // provides the answer/approve/reject actions; state lives in the transcript.
  const interactionActions = useInteractionActions(sessionId);
  // Unread write side: the OPEN session is being read — stamp markRead on select, on live
  // activity while viewing, and on tab re-focus (only while the document is visible).
  useMarkSessionRead(sessionId, `${liveTail.length}:${running}`);

  const transcript = transcriptQuery.data ?? EMPTY_TRANSCRIPT;
  const rows = useMemo(
    () => buildTranscriptRows(transcript, liveTail, {
      streaming, running, streamingText, pendingUser: optimistic.pendingUser,
      formatDivider: formatDividerFromVocab(L),
      stripScheduledPrefix: !!active?.scheduleId || isScheduledRun,
    }),
    [transcript, liveTail, streaming, running, streamingText, optimistic.pendingUser, L, active?.scheduleId, isScheduledRun],
  );
  // A New Session is only a draft until its first optimistic row is enqueued. Keep this derived from
  // rendered evidence so a rejected create-and-send naturally returns to the centered start state.
  const preFirstMessage = isDraft && rows.length === 0;
  const turns = turnCount(transcriptQuery.data);
  // The composer status line shows the REAL agent-turn count (the number that grows as the agent
  // works), NOT the number of user-message rounds (`turns`). Snapshot + delta: the live `session.turn`
  // event wins, else the `SessionInfo.numTurns` snapshot from sessions.list (restored on mount/reload).
  const agentTurns = resolveTurns(liveTurns, active?.numTurns ?? null);
  // Running-line elapsed = the CURRENT turn's runtime only (last turn's intra-turn span), not the
  // whole-session accumulated time — a fresh turn's clock starts from its own user message.
  const elapsed = useMemo(() => formatElapsed(currentTurnElapsedMs(transcriptQuery.data)), [transcriptQuery.data]);
  // Whole-session wall-clock lifetime, which the totals DTO deliberately does not carry: it is a
  // property of the session record (createdAt → lastUsedAt), not of its runs.
  const sessionSpan = useMemo(
    () => sessionSpanMs(active?.createdAt, active?.lastUsedAt),
    [active?.createdAt, active?.lastUsedAt],
  );
  // A session "has history" once it carries at least one turn — the switch rule uses this to allow
  // only same-backend profile switches on a live conversation. Live streaming counts too.
  const hasHistory = turns > 0 || liveTail.length > 0;
  const compactAction = useSessionCompact(sessionId, {
    running,
    hasBackendHistory: !!active?.backendSessionId,
  });

  // Message edit + rewind (sec-23): submit fires the real `sessions.rewind` mutation; the
  // transcript + rail refetch on settle (and again on the `session.rewound` event / regeneration
  // stream). Editing is greyed out while running (`edit.running`) — the server double-guards.
  const queryClient = useQueryClient();
  const rewindMut = useMutation(trpc.sessions.rewind.mutationOptions({
    onSettled: () => {
      if (!sessionId) return;
      queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }));
      queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
      invalidateActiveSubagentTranscriptQueries(queryClient, trpc, sessionId);
    },
  }));
  const edit = useMemo<MessageEditCtx | undefined>(() => {
    if (!sessionId) return undefined;
    return {
      running,
      busy: rewindMut.isPending,
      onSubmit: (turnIndex, text) => rewindMut.mutate({ sessionId, turnIndex, text }),
    };
  }, [sessionId, running, rewindMut]);

  // The rail's session lists are already scoped to the current project, so a live session's own
  // project and the selected one agree; a draft has only the latter.
  const projectName = active?.projectId ?? currentProjectId ?? null;

  return (
    <div
      ref={chatDropTargetRef}
      data-pane="center"
      style={{
        // Positioning context for the pane-wide file-drop overlay the composer portals in here.
        position: 'relative',
        flexGrow: grow,
        flexShrink: 1,
        flexBasis: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        // No background of its own: the transcript reads directly on the workspace pane's glass,
        // which is what makes the chat feel like it is on the ground rather than in a white box.
        minHeight: 0,
      }}
    >
      <ChatHeader
        title={title}
        running={running}
        projectName={projectName}
        backendSessionId={active?.backendSessionId ?? null}
        sessionName={active?.name ?? null}
      />
      {/* Sits OUTSIDE the transcript grid so it never scrolls away: a commission's anchor has to
          survive the whole conversation, not just its first screen. */}
      {active?.commissionId && <CommissionBanner commissionId={active.commissionId} />}
      <div
        data-chat-phase={preFirstMessage ? 'pre-start' : 'active'}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          // The implicit `auto` column takes its minimum from the items' min-content width, and both
          // items cap at the 756px prose column — so on a window narrower than 340+756+400 the grid
          // refused to shrink with the pane and the transcript + composer were painted 96px OVER the
          // right panel (the pane does not clip, and a block background paints before sibling text).
          // An explicit `minmax(0, 1fr)` column lets the chat narrow with its pane; wide blocks then
          // scroll inside themselves, which is what `pre`/table already do.
          gridTemplateColumns: 'minmax(0, 1fr)',
          gridTemplateRows: preFirstMessage
            ? 'minmax(0, 1fr) auto minmax(0, 1fr)'
            : 'minmax(0, 1fr) auto minmax(0, 0fr)',
          transition: 'grid-template-rows 420ms cubic-bezier(.22,1,.36,1)',
        }}
      >
        {preFirstMessage ? (
          <DraftHero title={L.wbNewConversation} projectName={projectName} />
        ) : (
          <MessageStream
            rows={rows}
            loading={!!sessionId && transcriptQuery.isPending}
            inlineThreadCard={sessionId ? <InlineThreadCardProto sessionId={sessionId} /> : undefined}
            interactionActions={interactionActions}
            edit={edit}
            streamKey={sessionId}
          />
        )}
        <Composer
          sessionId={sessionId}
          running={running}
          backgroundRunning={backgroundRunning}
          waitingOn={active?.waitingOn ?? 0}
          turns={agentTurns}
          cost={active?.costUsd ?? null}
          elapsed={elapsed}
          totals={active?.totals ?? null}
          sessionSpanMs={sessionSpan}
          isDraft={isDraft}
          currentProfile={active?.profileName ?? null}
          currentOverride={active?.selectionOverride ?? null}
          currentAgent={active?.agentName}
          sessionBrowser={active?.browser ?? null}
          sessionCommission={sessionCommission}
          hasHistory={hasHistory}
          draftSelection={draftSelection}
          draftReloadToken={draftReloadToken}
          projectId={currentProjectId ?? 'general'}
          prepareOptimistic={optimistic.prepare}
          enqueueOptimistic={optimistic.enqueue}
          acceptOptimistic={optimistic.accept}
          rejectOptimistic={optimistic.reject}
          showStatus={!preFirstMessage}
          statusStarting={optimistic.pendingUser.length > 0}
          turnProgressStarted={liveTurns !== null || streaming}
          compactAction={active?.contextCompactionSupported ? compactAction : undefined}
          todos={todos}
          waitpoints={waitpoints}
          dropTargetRef={chatDropTargetRef}
          onOpenSettings={onOpenSettings}
          contextControl={(active?.contextCompactionSupported || contextUsage !== null) ? (
            <ContextUsageControl
              usage={contextUsage}
              supported={!!active?.contextCompactionSupported}
              variant="desktop"
              lang={lang}
              compactAction={active?.contextCompactionSupported ? compactAction : undefined}
            />
          ) : undefined}
        />
        <div aria-hidden="true" style={{ minHeight: 0 }} />
      </div>
      {isScheduledRun && (
        <div
          style={{
            font: "400 9.5px 'IBM Plex Mono',monospace",
            color: 'var(--proto-faint)',
            maxWidth: 760,
            margin: '0 auto',
            width: '100%',
            boxSizing: 'border-box',
            padding: '0 24px 10px',
            flex: 'none',
          }}
        >
          {L.wbSchedReplyHint}
        </div>
      )}
    </div>
  );
}
