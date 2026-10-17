import { useMemo, useRef } from 'react';
import { useLang, useVocab } from '@/i18n';
import { MENU_FOCUS } from '@/design/MenuChrome';
import { shortSessionId } from '@/features/session/metadata/short-session-id';
import { ChatHeader } from './ChatHeader';
import { sessionDisplayTitle } from '@/features/session/metadata/session-display-title';
import { TranscriptLoadError } from '@/features/session/transcript/TranscriptLoadError';
import { MessageStream, type MessageEditCtx } from '@/features/session/transcript/MessageStream';
import { Composer } from '@/features/workbench/composer/Composer';
import { ContextUsageControl } from '@/features/session/composer/ContextUsageControl';
import { useChatSession } from '@/features/session/chat/useChatSession';
import { buildTranscriptRows, capsDayDivider } from '@/features/session/transcript/transcript-vm';
import { sessionSpanMs } from '@/features/session/list/session-stats';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useSelectedSession } from '@/features/session/state/SelectedSessionProvider';
import { useProjectSessions } from '@/features/projects/useProjectSessions';
import { DockedBoardCapsule } from '@/features/board/BoardCapsule';
import { BoardStreamProvider } from '@/features/board/BoardChatRows';
import { useAutoOpenNewBoard } from '@/features/board/useAutoOpenNewBoard';
import { useTeamContext } from '@/features/team/useTeamContext';
import { TeamCapsule } from '@/features/team/TeamRoster';
import { TeamStreamProvider } from '@/features/team/TeamStreamRows';

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
// so a mid-turn session never shows idle after switching away and back.

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

function SelectionPending({ failed, onRetry }: { failed: boolean; onRetry: () => void }): JSX.Element {
  const L = useVocab();
  return (
    <div role={failed ? 'alert' : 'status'} style={{ alignSelf: 'start', justifySelf: 'center', padding: 16, fontSize: 12 }}>
      {failed ? L.wbSessionsFailed : L.cmLoading}
      {failed && (
        <button type="button" className={MENU_FOCUS} onClick={onRetry}
          style={{ marginLeft: 8, color: 'var(--proto-accent)', cursor: 'pointer' }}>
          {L.cmRetry}
        </button>
      )}
    </div>
  );
}

// `grow` is the pane's share of the fluid center region — 1 normally, `1 - split` while a preview
// is pinned beside the chat (WorkbenchView owns the split).
export function CenterChat({ grow = 1, onOpenSettings, onOpenUsage }: {
  grow?: number;
  onOpenSettings?: () => void;
  onOpenUsage?: () => void;
} = {}): JSX.Element {
  const L = useVocab();
  const lang = useLang();
  const chatDropTargetRef = useRef<HTMLDivElement>(null);
  const { currentProjectId } = useCurrentProject();
  const { selectedSessionId, isDraft, setSelectedSession } = useSelectedSession();
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

  // Team mode: a worker's header names its lead; a lead gets its workers as a strip under the header.
  const team = useTeamContext(isDraft ? null : active, sessionsQuery.data);

  const sessionId = active?.sessionId ?? (isDraft ? '' : selectedSessionId ?? '');
  // A board the agent here creates opens in the dock as it is created (live events only).
  useAutoOpenNewBoard(isDraft ? null : sessionId || null);
  // Schedule context (design 30c): the chat is identical to a normal conversation — the only
  // scheduled affordances left are the title annotation「schedule 名 · run #n」on an un-adopted
  // run and the reply-adopts hint under the composer. Management lives in the rail/modal.
  const chat = useChatSession(sessionId, active, {
    isDraft, projectId: currentProjectId ?? 'general', scheduledRuns: scheduledSessionsQuery.data,
  });
  const selectionFailed = sessionsQuery.isError || scheduledSessionsQuery.isError;
  const selectionTitle = sessionId ? shortSessionId(sessionId) : selectionFailed ? L.wbSessionsFailed : L.cmLoading;
  const title = isDraft
    ? L.wbNewConversation
    : active
      ? sessionDisplayTitle(active, chat.runTitle)
      : selectionTitle;

  const rows = useMemo(
    () => buildTranscriptRows(chat.transcript, chat.liveTail, {
      streaming: chat.streaming, running: chat.running, streamingText: chat.streamingText, thinkingText: chat.thinkingText,
      pendingUser: chat.pendingUser,
      formatDivider: capsDayDivider(lang),
      stripScheduledPrefix: !!active?.scheduleId || chat.isScheduledRun,
    }),
    [chat.transcript, chat.liveTail, chat.streaming, chat.running, chat.streamingText, chat.thinkingText, chat.pendingUser,
      lang, active?.scheduleId, chat.isScheduledRun],
  );
  // A New Session is only a draft until its first optimistic row is enqueued. Keep this derived from
  // rendered evidence so a rejected create-and-send naturally returns to the centered start state.
  const preFirstMessage = isDraft && rows.length === 0;
  // Whole-session wall-clock lifetime, which the totals DTO deliberately does not carry: it is a
  // property of the session record (createdAt → lastUsedAt), not of its runs.
  const sessionSpan = useMemo(
    () => sessionSpanMs(active?.createdAt, active?.lastUsedAt),
    [active?.createdAt, active?.lastUsedAt],
  );
  // Message edit + rewind (sec-23). Editing is greyed out while running — the server double-guards.
  const { rewind } = chat;
  const edit = useMemo<MessageEditCtx | undefined>(() => {
    if (!sessionId) return undefined;
    return { running: chat.running, busy: rewind.pending, onSubmit: rewind.submit };
  }, [sessionId, chat.running, rewind.pending, rewind.submit]);

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
        metadataSession={!isDraft && active ? { sessionId: active.sessionId, title, starred: active.starred } : null}
        running={chat.running}
        projectName={projectName}
        backendSessionId={active?.backendSessionId ?? null}
        parent={team.lead ? { title: sessionDisplayTitle(team.lead, null), onSelect: () => setSelectedSession(team.lead!.sessionId) } : null}
        team={team.workers.length > 0 ? <TeamCapsule workers={team.workers} onOpen={setSelectedSession} /> : null}
        board={!isDraft && active?.boardId ? <DockedBoardCapsule boardId={active.boardId} /> : null}
      />
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
        {!isDraft && !sessionId ? (
          <SelectionPending failed={selectionFailed} onRetry={() => {
            void sessionsQuery.refetch();
            void scheduledSessionsQuery.refetch();
          }} />
        ) : preFirstMessage ? (
          <DraftHero title={L.wbNewConversation} projectName={projectName} />
        ) : chat.transcriptError && rows.length === 0 ? (
          <TranscriptLoadError onRetry={chat.retryTranscript} />
        ) : (
          <TeamStreamProvider workers={team.workers} leadRunning={chat.running} onOpenWorker={setSelectedSession}>
            <BoardStreamProvider>
              <MessageStream
                rows={rows}
                loading={!!sessionId && chat.transcriptPending}
                interactionActions={chat.interactionActions}
                edit={edit}
                streamKey={sessionId}
              />
            </BoardStreamProvider>
          </TeamStreamProvider>
        )}
        <Composer
          sessionId={sessionId}
          running={chat.running}
          backgroundRunning={chat.backgroundRunning}
          waitingOn={active?.waitingOn ?? 0}
          turns={chat.turns}
          cost={active?.costUsd ?? null}
          turnClock={chat.turnClock}
          totals={active?.totals ?? null}
          sessionSpanMs={sessionSpan}
          isDraft={isDraft}
          currentSelection={active?.selection}
          currentAgent={active?.agentName}
          sessionBrowser={active?.browser ?? null}
          hasHistory={chat.hasHistory}
          projectId={currentProjectId ?? 'general'}
          optimistic={chat.optimistic}
          showStatus={!preFirstMessage}
          turnProgressStarted={chat.liveTurns !== null || chat.streaming}
          compactAction={chat.compactAction}
          todos={chat.todos}
          waitpoints={chat.waitpoints}
          dropTargetRef={chatDropTargetRef}
          onOpenSettings={onOpenSettings}
          onOpenUsage={onOpenUsage}
          contextControl={(chat.compactAction || chat.contextUsage !== null) ? (
            <ContextUsageControl usage={chat.contextUsage} compactAction={chat.compactAction} />
          ) : undefined}
        />
        <div aria-hidden="true" style={{ minHeight: 0 }} />
      </div>
      {chat.isScheduledRun && (
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
