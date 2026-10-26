import { mobileHeaderBack } from '@/mobile/mobile-navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { fmt, useLang, useVocab } from '@/i18n';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useAllSessions } from '@/features/projects/useProjectSessions';
import { useChatSession } from '@/features/session/chat/useChatSession';
import { useComposerSend } from '@/features/session/chat/useComposerSend';
import { useSessionSelection } from '@/features/session/composer/useSessionSelection';
import { useDraftSelection } from '@/features/session/state/useDraftSelection';
import {
  resolveTransitionClean, type DraftSelection, type PendingCreatedSession, type SelectionChange,
} from '@/features/session/state/selected-session';
import { sessionSpanMs, sessionStatsView, type SessionStatsRow } from '@/features/session/list/session-stats';
import { sessionDisplayTitle } from '@/features/session/metadata/session-display-title';
import { useTeamContext } from '@/features/team/useTeamContext';
import { teamRoster } from '@/features/team/worker-roster';
import { attachmentType, type AttachmentUploadItem } from '@/features/attachments/types';
import { normalizeMobilePath } from '../mobile-route-manifest';
import { SAME_SCREEN_STATE } from '../MobileAnimatedOutlet';
import { MChatView } from './MChatView';
import {
  buildMobileChatRows, mobileRunStatus,
  type ChatHeaderStatus, type SelectionSheetRow, type PendingAttachmentVM,
} from './m-chat-vm';
import { useMobileInteractions, type MobileInteractionRouting } from './m-chat-interactions';
import { useMobileMessageEdit, type MobileMessageEdit } from './m-chat-edit';
import type { UsageNavState } from './MUsageScreen';
import type { MChatViewProps } from './MChatView.types';

const DRAFT_PATH = '/m/session/new';

/** The open session: looked up across every project — the session decides the project, not the
 *  other way round — and among scheduled runs too, which open on the same page. */
function useRouteSession() {
  const { sessionId: routeParam } = useParams<{ sessionId: string }>();
  const isDraft = routeParam === 'new';
  const sessionsQuery = useAllSessions('direct');
  const scheduledSessionsQuery = useAllSessions('scheduled');
  const active = useMemo(() => {
    const list = [...(sessionsQuery.data ?? []), ...(scheduledSessionsQuery.data ?? [])];
    return list.find((s) => s.sessionId === routeParam) ?? null;
  }, [sessionsQuery.data, scheduledSessionsQuery.data, routeParam]);
  const { currentProjectId, setCurrentProject } = useCurrentProject();
  const activeProjectId = isDraft ? null : active?.projectId ?? null;
  useEffect(() => {
    if (activeProjectId && activeProjectId !== currentProjectId) setCurrentProject(activeProjectId);
  }, [activeProjectId, currentProjectId, setCurrentProject]);
  return {
    routeParam,
    isDraft,
    active: isDraft ? null : active,
    sessionId: isDraft ? '' : (active?.sessionId ?? routeParam ?? ''),
    projectId: currentProjectId,
    directSessions: sessionsQuery.data,
    scheduledSessions: scheduledSessionsQuery.data,
  };
}

/** A created session's own row lands in sessions.list a moment after the send; until it does, the
 *  engine chip keeps saying what the draft was created with. */
function usePendingCreatedSession(activeSessionId: string | undefined, isDraft: boolean, sessionId: string) {
  const [pending, setPending] = useState<PendingCreatedSession | null>(null);
  useEffect(() => {
    if (!pending) return;
    const authoritativeArrived = activeSessionId === pending.sessionId;
    const movedElsewhere = !isDraft && sessionId !== pending.sessionId;
    if (authoritativeArrived || movedElsewhere) setPending(null);
  }, [activeSessionId, isDraft, pending, sessionId]);
  return [pending, setPending] as const;
}

/** Clean mode: a draft's switch beside the agent chip; afterwards, a clean session's workspace. */
function cleanViewProps(input: {
  isDraft: boolean;
  draft: DraftSelection;
  setDraft: (change: SelectionChange) => void;
  creating: boolean;
  clean: boolean;
  workspaceDir: string | null;
}): Pick<MChatViewProps, 'cleanDraft' | 'cleanWorkspace'> {
  if (!input.isDraft) return { cleanDraft: null, cleanWorkspace: input.clean ? { dir: input.workspaceDir } : null };
  const on = !!input.draft.clean;
  return { cleanDraft: { on, disabled: input.creating, onToggle: () => input.setDraft({ clean: !on }) }, cleanWorkspace: null };
}

/** Whole-session totals — the ⋯ menu's「会话统计」sheet. Same vm as desktop; only `summary` goes
 *  unused here, because the mobile header line has no room for a second segment. */
function useSessionStatsRows(active: SessionInfo | null): SessionStatsRow[] | null {
  const vocab = useVocab();
  const lang = useLang();
  return useMemo(
    () => sessionStatsView(active?.totals ?? null, sessionSpanMs(active?.createdAt, active?.lastUsedAt), {
      scope: vocab.wbSessionScope, turnsUnit: vocab.wbTurnsUnit, runsUnit: vocab.wbRunsUnit,
      runsLabel: vocab.wbStatRuns, turnsLabel: vocab.wbStatTurns, activeLabel: vocab.wbStatActive,
      spanLabel: vocab.wbStatSpan, costLabel: vocab.wbStatCost, subagentLabel: vocab.wbStatSubagent,
    }, lang)?.rows ?? null,
    [active?.totals, active?.createdAt, active?.lastUsedAt, vocab, lang],
  );
}

function pendingAttachment(upload: AttachmentUploadItem, fallbackName: string): PendingAttachmentVM {
  const type = attachmentType(upload);
  return {
    id: upload.id,
    name: upload.file?.name ?? upload.meta?.name ?? fallbackName,
    progress: upload.progress,
    status: upload.status,
    type: type === 'image' || type === 'video' ? type : 'file',
    previewUrl: upload.previewUrl,
  };
}

/** Edit (7b) and interaction routing (5a/5b) both take the composer over before an ordinary send. */
function sendRoute(input: {
  edit: Pick<MobileMessageEdit, 'armed' | 'submit'>;
  routing: Pick<MobileInteractionRouting, 'rejectArmed' | 'answering' | 'submit'>;
  composer: { canSend: boolean; submit: () => void };
  text: string;
  uploadsBusy: boolean;
  rewindPending: boolean;
  interactionsBusy: boolean;
}): { sendEnabled: boolean; onSend: () => void } {
  const { edit, routing, composer } = input;
  const typed = !!input.text.trim() && !input.uploadsBusy;
  const takenOver = edit.armed || routing.rejectArmed || routing.answering;
  const busy = edit.armed ? input.rewindPending : input.interactionsBusy;
  const sendEnabled = takenOver ? typed && !busy : composer.canSend;
  const onSend = (): void => {
    if (!takenOver) { composer.submit(); return; }
    if (!sendEnabled) return;
    if (edit.armed) edit.submit(input.text.trim());
    else routing.submit(input.text.trim());
  };
  return { sendEnabled, onSend };
}

export function MChatScreen(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const lang = useLang();
  const vocab = useVocab();
  const route = useRouteSession();
  const { isDraft, active, sessionId } = route;
  // Team mode: a worker's header names its lead; a lead shows its workers under the header.
  const team = useTeamContext(active, route.directSessions);
  const chat = useChatSession(sessionId, active, {
    isDraft, projectId: route.projectId ?? 'general', scheduledRuns: route.scheduledSessions,
  });
  const rows = useMemo(
    () => buildMobileChatRows(chat.transcript, chat.liveTail, {
      streaming: chat.streaming, running: chat.running, streamingText: chat.streamingText, thinkingText: chat.thinkingText,
      pendingUser: chat.pendingUser, stripScheduledPrefix: !!active?.scheduleId || chat.isScheduledRun, lang,
    }),
    [chat.transcript, chat.liveTail, chat.streaming, chat.running, chat.streamingText, chat.thinkingText, chat.pendingUser,
      active?.scheduleId, chat.isScheduledRun, lang],
  );

  const [systemLines, setSystemLines] = useState<string[]>([]);
  const addSystemLine = (line: string): void => setSystemLines((prev) => [...prev, line]);

  // ── engine + environment (1p) ──
  const [draftSelection, setDraftSelection] = useDraftSelection(isDraft);
  const [pendingCreatedSession, setPendingCreatedSession] = usePendingCreatedSession(active?.sessionId, isDraft, sessionId);
  const selection = useSessionSelection({
    sessionId, isDraft, hasHistory: chat.hasHistory,
    currentSelection: active?.selection,
    currentAgent: active?.agentName,
    draftSelection, setDraftSelection, pendingCreatedSession,
  });
  const onPickSelection = (row: SelectionSheetRow): void => {
    if (row.modelOption) selection.pickModel(row.modelOption);
    else selection.apply(row.change);
  };

  // Follow a created session only while this screen is still the draft on screen: a user who has
  // already gone back stays where they went.
  const onDraftScreen = useRef(false);
  onDraftScreen.current = isDraft && normalizeMobilePath(location.pathname) === DRAFT_PATH;
  const composer = useComposerSend({
    sessionId, isDraft, projectId: route.projectId ?? 'general',
    optimistic: chat.optimistic, running: chat.running, compactAction: chat.compactAction,
    creation: { selection: draftSelection },
    slash: {
      modelOptions: selection.favoriteOptions,
      backend: selection.effective.backend,
      agentName: selection.agentName,
      onNew: () => navigate(DRAFT_PATH),
      onModel: (option) => selection.pickModel(option),
      onSettings: () => navigate('/m/settings'),
      onUsage: () => navigate('/m/settings/usage', { state: { from: 'chat' } satisfies UsageNavState }),
    },
    onCreated: (createdId) => {
      if (!onDraftScreen.current) return;
      setPendingCreatedSession({
        sessionId: createdId,
        selection: draftSelection.selection,
        agentName: draftSelection.agentName ?? null,
        ...(draftSelection.clean ? { clean: true } : {}),
      });
      // The same screen carries on as the created session, so the row and chip stay put.
      navigate(`/m/session/${createdId}`, { replace: true, state: SAME_SCREEN_STATE });
    },
    onSendFailed: (error) => addSystemLine(fmt(vocab.chatSendFailed, { error: error.message })),
    onSlashFeedback: (key) => { if (key) addSystemLine(vocab[key]); },
  });
  const { text, setText, uploads } = composer;

  // ── edit (7b) and interaction routing (5a/5b) both take the composer over before a send ──
  const edit = useMobileMessageEdit({
    rows, running: chat.running, text, setText, rewind: chat.rewind, onStart: () => routing.disarmReject(),
  });
  const routing = useMobileInteractions({
    rows, sessionId, actions: chat.interactionActions, editing: edit.armed, setText,
  });
  const { sendEnabled, onSend } = sendRoute({
    edit, routing, composer, text, uploadsBusy: uploads.hasNonDone,
    rewindPending: chat.rewind.pending, interactionsBusy: !!chat.interactionActions.busy,
  });
  const sessionStatsRows = useSessionStatsRows(active);
  // A pending interaction outranks everything; then the phone's plain-words run line.
  const runLine = mobileRunStatus({
    isDraft, running: chat.running, backgroundRunning: chat.backgroundRunning,
    starting: chat.pendingUser.length > 0, turns: chat.turns, cost: active?.costUsd ?? null,
    turnClock: chat.turnClock, waitingOn: active?.waitingOn ?? 0,
    workers: teamRoster(team.workers).active.length, lastUsedAt: active?.lastUsedAt ?? null,
  }, vocab, lang);
  const status: ChatHeaderStatus = routing.headerStatus
    ?? { running: runLine.active, tone: runLine.active ? 'running' : 'idle', text: runLine.text, liveText: runLine.liveText };
  const title = isDraft
    ? vocab.newSession
    : (active ? sessionDisplayTitle(active, chat.runTitle) : route.routeParam ?? '');
  // 8d hint above the composer: replying extracts the run into a normal session.
  const schedHint = chat.isScheduledRun ? vocab.chatScheduledHint : null;

  return (
    <MChatView
      title={title}
      parent={team.lead ? { title: sessionDisplayTitle(team.lead, null), onSelect: () => navigate(`/m/session/${team.lead!.sessionId}`) } : null}
      workers={team.workers}
      // Opened from the team sheet: replacing its back-guard entry keeps back from the worker on the lead.
      onOpenWorker={(id) => navigate(`/m/session/${id}`, { replace: true })}
      onOpenWorkerFromChat={(id) => navigate(`/m/session/${id}`)}
      boardId={isDraft ? null : active?.boardId ?? null}
      onOpenBoardSession={(id) => { if (id !== sessionId) navigate(`/m/session/${id}`); }}
      metadataSession={!isDraft && active ? { sessionId: active.sessionId, title, starred: active.starred } : null}
      status={status}
      rows={rows}
      live={chat.running && !chat.backgroundRunning}
      backgroundRunning={chat.backgroundRunning}
      loading={!!sessionId && chat.transcriptPending}
      fetched={chat.transcriptFetched}
      readMark={!isDraft && active ? { lastReadAt: active.lastReadAt, origin: active.origin } : undefined}
      transcriptError={chat.transcriptError}
      onRetryTranscript={chat.retryTranscript}
      onBack={() => mobileHeaderBack(navigate, '/m/sessions')}
      sessionStatsRows={sessionStatsRows}
      backendUuid={active?.backendSessionId ?? null}
      systemLines={schedHint ? [...systemLines, schedHint] : systemLines}
      interactions={routing.interactions}
      rejectBar={routing.rejectBar}
      msgMenu={edit.msgMenu}
      onLongPress={edit.hold}
      editing={edit.editing}
      sessionId={sessionId}
      todos={chat.todos}
      waitpoints={chat.waitpoints}
      composerValue={text}
      onComposerChange={setText}
      onSend={onSend}
      onCommands={composer.openCommands}
      slashSuggestions={edit.armed || routing.rejectArmed || routing.answering ? [] : composer.slashSuggestions}
      onSlashPick={(suggestion) => { composer.pickSlash(suggestion); }}
      sendEnabled={sendEnabled}
      composerPlaceholder={routing.placeholder}
      onStop={composer.stop}
      stopEnabled={!composer.stopPending}
      selection={selection}
      onPickSelection={onPickSelection}
      {...cleanViewProps({
        isDraft, draft: draftSelection, setDraft: setDraftSelection, creating: composer.creating,
        clean: resolveTransitionClean(active?.clean, pendingCreatedSession, sessionId),
        workspaceDir: active?.workspaceDir ?? null,
      })}
      contextUsage={chat.contextUsage}
      contextUsageSupported={!!active?.contextCompactionSupported}
      contextCompactAction={chat.compactAction}
      attachments={uploads.items.map((upload) => pendingAttachment(upload, vocab.chatFileFallback))}
      onRemoveAttachment={uploads.remove}
      onRetryAttachment={uploads.retry}
      onAddFiles={uploads.addFiles}
    />
  );
}
