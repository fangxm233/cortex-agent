// input:  selected session, transcript/live state and optimistic sends
// output: reconciled desktop chat with context controls and composer
// pos:    Workbench conversation pane orchestration
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  acceptOptimisticUserMessage,
  createOptimisticUserMessage,
  promoteOptimisticUserMessage,
  reconcileOptimisticUserMessages,
  resolveOptimisticRejection,
  shouldSelectCreatedSession,
  type OptimisticUserMessage,
  type UserMessageAuthority,
} from './optimistic-message';
import type { Attachment } from './transcript-vm';

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
  // is resolved from the same list the rail shows.
  const sessionsQuery = useQuery(
    trpc.sessions.list.queryOptions({ origin: 'direct', projectId: currentProjectId ?? undefined }),
  );

  // The active session is the shared cross-pane selection (a LeftRail click), resolved against the
  // scoped list. No local most-recent computation — selection is the single source of truth.
  const active = useMemo(() => {
    const list = sessionsQuery.data ?? [];
    return list.find((s) => s.sessionId === selectedSessionId) ?? null;
  }, [sessionsQuery.data, selectedSessionId]);

  const sessionId = active?.sessionId ?? (isDraft ? '' : selectedSessionId ?? '');
  const title = isDraft ? L.wbNewConversation : active ? (active.label ?? active.name) : 'No session';

  const transcriptQuery = useQuery({
    ...trpc.sessions.transcript.queryOptions({ sessionId }),
    enabled: !!sessionId,
  });

  // `deltas: true` — this is the surface that shows a live preview, so it opens the session-scoped
  // delta subscription. The reply then appears token by token instead of arriving whole after the
  // whole block is generated (measured on a long answer: first text at ~3.6s, complete at ~22s).
  // `transcript` is passed back in only so a pending row self-heals if its delivered event is lost.
  const { liveTail, streaming, running, backgroundRunning, liveTurns, contextUsage, streamingText, pendingUser } =
    useSessionMessageLiveSync(sessionId, active?.running, active?.backgroundRunning, {
      deltas: true,
      transcript: transcriptQuery.data ?? null,
      contextUsage: active?.contextUsage ?? null,
    });
  const [optimisticUser, setOptimisticUser] = useState<OptimisticUserMessage[]>([]);
  const optimisticRef = useRef<OptimisticUserMessage[]>([]);
  const currentProjectRef = useRef(currentProjectId ?? 'general');
  const draftActiveRef = useRef(isDraft);
  currentProjectRef.current = currentProjectId ?? 'general';
  draftActiveRef.current = isDraft;
  const authorityRef = useRef<UserMessageAuthority>({
    transcript: { sessionId, turns: [], pendingUserMessages: [] }, liveTail: [], pendingUser: [],
  });
  const authority = useMemo<UserMessageAuthority>(() => ({
    transcript: transcriptQuery.data ?? { sessionId, turns: [], pendingUserMessages: [] },
    liveTail,
    pendingUser,
  }), [transcriptQuery.data, sessionId, liveTail, pendingUser]);
  authorityRef.current = authority;

  const updateOptimistic = useCallback((update: (current: OptimisticUserMessage[]) => OptimisticUserMessage[]) => {
    setOptimisticUser((current) => {
      const next = update(current);
      optimisticRef.current = next;
      return next;
    });
  }, []);
  const scopedOptimistic = useMemo(() => optimisticUser.filter((message) => isDraft
    ? message.target.kind === 'draft' && message.target.projectId === (currentProjectId ?? 'general')
    : message.target.kind === 'session' && message.target.sessionId === sessionId),
  [optimisticUser, isDraft, currentProjectId, sessionId]);
  const optimisticRows = useMemo(
    () => reconcileOptimisticUserMessages(scopedOptimistic, authority),
    [scopedOptimistic, authority],
  );
  useEffect(() => {
    if (optimisticRows.settledClientIds.length === 0) return;
    const settled = new Set(optimisticRows.settledClientIds);
    updateOptimistic((current) => current.filter((message) => !settled.has(message.clientId)));
  }, [optimisticRows.settledClientIds, updateOptimistic]);

  const prepareOptimistic = useCallback((text: string, attachments?: Attachment[]) => {
    const target = isDraft
      ? { kind: 'draft' as const, projectId: currentProjectId ?? 'general' }
      : { kind: 'session' as const, sessionId };
    return createOptimisticUserMessage({
      clientId: crypto.randomUUID(), target, text, attachments, ts: new Date().toISOString(),
    }, optimisticRef.current, authorityRef.current);
  }, [isDraft, currentProjectId, sessionId]);
  const enqueueOptimistic = useCallback((message: OptimisticUserMessage) => {
    updateOptimistic((current) => [...current, message]);
  }, [updateOptimistic]);
  const acceptOptimistic = useCallback((clientId: string, createdSessionId?: string) => {
    const message = optimisticRef.current.find((item) => item.clientId === clientId);
    const selectCreated = !!createdSessionId && !!message
      && shouldSelectCreatedSession(message, currentProjectRef.current, draftActiveRef.current);
    updateOptimistic((current) => createdSessionId
      ? promoteOptimisticUserMessage(current, clientId, createdSessionId)
      : acceptOptimisticUserMessage(current, clientId));
    return createdSessionId ? selectCreated : true;
  }, [updateOptimistic]);
  const rejectOptimistic = useCallback((clientId: string) => {
    const resolution = resolveOptimisticRejection(optimisticRef.current, clientId, authorityRef.current);
    updateOptimistic(() => resolution.messages);
    return resolution.restore;
  }, [updateOptimistic]);
  // Interaction cards are transcript rows now (web-interactions-redesign) — this hook only
  // provides the answer/approve/reject actions; state lives in the transcript.
  const interactionActions = useInteractionActions(sessionId);
  // Unread write side: the OPEN session is being read — stamp markRead on select, on live
  // activity while viewing, and on tab re-focus (only while the document is visible).
  useMarkSessionRead(sessionId, `${liveTail.length}:${running}`);

  const transcript = transcriptQuery.data ?? EMPTY_TRANSCRIPT;
  const rows = useMemo(
    () => buildTranscriptRows(transcript, liveTail, {
      streaming, streamingText, pendingUser: optimisticRows.pendingUser, formatDivider: formatDividerFromVocab(L),
    }),
    [transcript, liveTail, streaming, streamingText, optimisticRows.pendingUser, L],
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
        running={running}
        onCmdK={onCmdK}
        sessionId={sessionId}
        backendSessionId={active?.backendSessionId ?? null}
        sessionName={active?.name ?? null}
        currentProfile={active?.profileName ?? null}
        hasHistory={hasHistory}
        isDraft={isDraft}
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
        draftProfile={draftProfile}
        draftReloadToken={draftReloadToken}
        projectId={currentProjectId ?? 'general'}
        prepareOptimistic={prepareOptimistic}
        enqueueOptimistic={enqueueOptimistic}
        acceptOptimistic={acceptOptimistic}
        rejectOptimistic={rejectOptimistic}
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
    </div>
  );
}
