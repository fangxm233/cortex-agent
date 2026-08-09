// input:  selected session, live snapshots, profiles and optimistic sends
// output: reconciled desktop chat with a profile-aware composer
// pos:    Workbench conversation pane orchestration
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang, useVocab } from '@/i18n';
import { ChatHeader } from './ChatHeader';
import { MessageStream, type MessageEditCtx } from './MessageStream';
import { InlineThreadCardProto } from './InlineThreadCardProto';
import { Composer } from './Composer';
import { ContextUsageControl } from './ContextUsageControl';
import { useSessionCompact } from './useSessionCompact';
import { useSessionMessageLiveSync } from './useSessionMessageLiveSync';
import { useInteractionActions } from './useInteractionActions';
import { useMarkSessionRead } from './useMarkSessionRead';
import { buildTranscriptRows, turnCount, resolveTurns, currentTurnElapsedMs, formatElapsed, formatDividerFromVocab } from './transcript-vm';
import { useCurrentProject } from './CurrentProjectProvider';
import { useSelectedSession } from './SelectedSessionProvider';
import { useOptimisticUserMessages } from './useOptimisticUserMessages';
import { scheduledRunTitle } from './schedule-rail';

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

// `grow` is the pane's share of the fluid center region — 1 normally, `1 - split` while a preview
// is pinned beside the chat (WorkbenchPage owns the split).
export function CenterChat({ grow = 1 }: { grow?: number } = {}): JSX.Element {
  const L = useVocab();
  const lang = useLang();
  const trpc = useTRPC();
  const { currentProjectId } = useCurrentProject();
  const { selectedSessionId, isDraft, draftProfile, draftReloadToken } = useSelectedSession();
  // Scoped to the current project (dedupes with the LeftRail / provider query) so the active session
  // is resolved from the same lists the rail shows — direct conversations AND scheduled runs
  // (design 27a-B puts both in the rail, so both must open here).
  const sessionsQuery = useQuery(
    trpc.sessions.list.queryOptions({ origin: 'direct', projectId: currentProjectId ?? undefined }),
  );
  const scheduledSessionsQuery = useQuery(
    trpc.sessions.list.queryOptions({ origin: 'scheduled', projectId: currentProjectId ?? undefined }),
  );

  // The active session is the shared cross-pane selection (a LeftRail click), resolved against the
  // scoped lists. No local most-recent computation — selection is the single source of truth.
  const active = useMemo(() => {
    const list = [...(sessionsQuery.data ?? []), ...(scheduledSessionsQuery.data ?? [])];
    return list.find((s) => s.sessionId === selectedSessionId) ?? null;
  }, [sessionsQuery.data, scheduledSessionsQuery.data, selectedSessionId]);

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
    ...trpc.sessions.transcript.queryOptions({ sessionId }),
    enabled: !!sessionId,
  });

  // `deltas: true` — this is the surface that shows a live preview, so it opens the session-scoped
  // delta subscription. The reply then appears token by token instead of arriving whole after the
  // whole block is generated (measured on a long answer: first text at ~3.6s, complete at ~22s).
  // `transcript` is passed back in only so a pending row self-heals if its delivered event is lost.
  const {
    liveTail, getMessageSnapshot, streaming, running, backgroundRunning,
    liveTurns, contextUsage, streamingText, pendingUser,
  } = useSessionMessageLiveSync(sessionId, active?.running, active?.backgroundRunning, {
      deltas: true,
      transcript: transcriptQuery.data ?? null,
      contextUsage: active?.contextUsage ?? null,
    });
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
      streaming, streamingText, pendingUser: optimistic.pendingUser, formatDivider: formatDividerFromVocab(L),
      stripScheduledPrefix: !!active?.scheduleId || isScheduledRun,
    }),
    [transcript, liveTail, streaming, streamingText, optimistic.pendingUser, L, active?.scheduleId, isScheduledRun],
  );
  const turns = turnCount(transcriptQuery.data);
  // The composer status line shows the REAL agent-turn count (the number that grows as the agent
  // works), NOT the number of user-message rounds (`turns`). Snapshot + delta: the live `session.turn`
  // event wins, else the `SessionInfo.numTurns` snapshot from sessions.list (restored on mount/reload).
  const agentTurns = resolveTurns(liveTurns, active?.numTurns ?? null);
  // Running-line elapsed = the CURRENT turn's runtime only (last turn's intra-turn span), not the
  // whole-session accumulated time — a fresh turn's clock starts from its own user message.
  const elapsed = useMemo(() => formatElapsed(currentTurnElapsedMs(transcriptQuery.data)), [transcriptQuery.data]);
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

  const onCmdK = () => {
    // Trigger the global ⌘K command palette (AppShell mounts it via a window keydown hook).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
  };

  return (
    <div
      data-pane="center"
      style={{
        flexGrow: grow,
        flexShrink: 1,
        flexBasis: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--proto-card)',
        minHeight: 0,
      }}
    >
      <ChatHeader
        title={title}
        onCmdK={onCmdK}
        backendSessionId={active?.backendSessionId ?? null}
        sessionName={active?.name ?? null}
      />
      <MessageStream
        rows={rows}
        loading={!!sessionId && transcriptQuery.isPending}
        inlineThreadCard={sessionId ? <InlineThreadCardProto sessionId={sessionId} /> : undefined}
        interactionActions={interactionActions}
        edit={edit}
        streamKey={sessionId}
      />
      <Composer
        sessionId={sessionId}
        running={running}
        backgroundRunning={backgroundRunning}
        turns={agentTurns}
        cost={active?.costUsd ?? null}
        elapsed={elapsed}
        isDraft={isDraft}
        currentProfile={active?.profileName ?? null}
        hasHistory={hasHistory}
        draftProfile={draftProfile}
        draftReloadToken={draftReloadToken}
        projectId={currentProjectId ?? 'general'}
        prepareOptimistic={optimistic.prepare}
        enqueueOptimistic={optimistic.enqueue}
        acceptOptimistic={optimistic.accept}
        rejectOptimistic={optimistic.reject}
        statusAccessory={(active?.contextCompactionSupported || contextUsage !== null) ? (
          <ContextUsageControl
            usage={contextUsage}
            supported={!!active?.contextCompactionSupported}
            variant="desktop"
            lang={lang}
            compactAction={active?.contextCompactionSupported ? compactAction : undefined}
          />
        ) : undefined}
      />
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
