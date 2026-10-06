import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { fmt, useLang, useVocab } from '@/i18n';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useAllSessions } from '@/features/projects/useProjectSessions';
import { useChatSession } from '@/features/session/chat/useChatSession';
import { useComposerSend } from '@/features/session/chat/useComposerSend';
import { runStatusLine } from '@/features/session/chat/run-status-line';
import { useSessionSelection } from '@/features/session/composer/useSessionSelection';
import { useDraftSelection } from '@/features/session/state/useDraftSelection';
import type { PendingCreatedSession } from '@/features/session/state/selected-session';
import { sessionSpanMs, sessionStatsView } from '@/features/session/list/session-stats';
import { sessionDisplayTitle } from '@/features/session/metadata/session-display-title';
import { agentChipParts, hasAgentChoice, selectionChipParts } from '@/features/session/list/selection-menu';
import { useBrowserDeviceOptions } from '@/features/browser/BrowserOptIn';
import {
  commissionRequestOf, useCommissionEnabled, useCommissionOptions, useCommissionTitle,
  useSessionCommission,
} from '@/features/commission/CommissionOptIn';
import { useTeamContext } from '@/features/team/useTeamContext';
import { attachmentType } from '@/features/attachments/types';
import { normalizeMobilePath } from '../mobile-route-manifest';
import { SAME_SCREEN_STATE } from '../MobileAnimatedOutlet';
import { MChatView } from './MChatView';
import {
  buildMobileChatRows, selectionChipLabel, buildAgentSheet, buildSelectionSheet,
  type ChatHeaderStatus, type SelectionSheetRow, type PendingAttachmentVM,
} from './m-chat-vm';
import { useMobileInteractions } from './m-chat-interactions';
import { useMobileMessageEdit } from './m-chat-edit';

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
      streaming: chat.streaming, running: chat.running, streamingText: chat.streamingText,
      pendingUser: chat.pendingUser, stripScheduledPrefix: !!active?.scheduleId || chat.isScheduledRun, lang,
    }),
    [chat.transcript, chat.liveTail, chat.streaming, chat.running, chat.streamingText, chat.pendingUser,
      active?.scheduleId, chat.isScheduledRun, lang],
  );

  const [systemLines, setSystemLines] = useState<string[]>([]);
  const addSystemLine = (line: string): void => setSystemLines((prev) => [...prev, line]);

  // ── engine + environment (1p) ──
  const [draftSelection, setDraftSelection] = useDraftSelection(isDraft);
  const [pendingCreatedSession, setPendingCreatedSession] = usePendingCreatedSession(active?.sessionId, isDraft, sessionId);
  const selection = useSessionSelection({
    sessionId, isDraft, hasHistory: chat.hasHistory,
    currentProfile: active?.profileName ?? null,
    currentOverride: active?.selectionOverride ?? null,
    currentAgent: active?.agentName,
    draftSelection, setDraftSelection, pendingCreatedSession,
  });
  // The line is written once the change has actually landed, so a refusal leaves no trace claiming
  // it did. The draft has nothing to refuse it, so it writes immediately.
  const noteSwitch = (to: string) => {
    const from = selectionChipLabel(selection.effective);
    return () => addSystemLine(fmt(vocab.chatEngineSwitched, { from, to }));
  };
  const onPickSelection = (row: SelectionSheetRow): void => selection.apply(row.change, noteSwitch(row.label));

  // Browser control and commission mode are chosen on the draft only: both decide what the agent's
  // process spawns with, so a live session can report them but never change them.
  const [draftBrowserDevice, setDraftBrowserDevice] = useState<string | null>(null);
  const [browserSheetOpen, setBrowserSheetOpen] = useState(false);
  const browserOptions = useBrowserDeviceOptions(browserSheetOpen);
  const [draftCommission, setDraftCommission] = useState<null | 'new' | string>(null);
  // The sheet's titles are gone once it closes, so the chip needs the chosen commission's title back.
  const draftCommissionTitle = useCommissionTitle(draftCommission);
  const [commissionSheetOpen, setCommissionSheetOpen] = useState(false);
  const commissionOptions = useCommissionOptions(commissionSheetOpen);
  const sessionCommission = useSessionCommission(active);
  // settings.commissionEnabled — with it off a draft offers no entry point; a live session's
  // read-only capsule is unaffected.
  const commissionEnabled = useCommissionEnabled();

  // Follow a created session only while this screen is still the draft on screen: a user who has
  // already gone back stays where they went.
  const onDraftScreen = useRef(false);
  onDraftScreen.current = isDraft && normalizeMobilePath(location.pathname) === DRAFT_PATH;
  const composer = useComposerSend({
    sessionId, isDraft, projectId: route.projectId ?? 'general',
    optimistic: chat.optimistic, running: chat.running, compactAction: chat.compactAction,
    creation: {
      selection: draftSelection,
      browserDevice: draftBrowserDevice,
      commission: commissionEnabled ? commissionRequestOf(draftCommission) : null,
    },
    slash: {
      profileOptions: selection.profileOptions,
      onNew: () => navigate(DRAFT_PATH),
      onProfile: (name) => selection.pickProfile(name, noteSwitch(name)),
      onSettings: () => navigate('/m/settings'),
    },
    onCreated: (createdId) => {
      if (!onDraftScreen.current) return;
      setPendingCreatedSession({
        sessionId: createdId,
        profileName: draftSelection.profileName,
        override: draftSelection.override,
        agentName: draftSelection.agentName ?? null,
      });
      // The same screen carries on as the created session, so the row and chip stay put.
      navigate(`/m/session/${createdId}`, { replace: true, state: SAME_SCREEN_STATE });
    },
    onSendFailed: (error) => addSystemLine(fmt(vocab.chatSendFailed, { error: error.message })),
    onSlashFeedback: (key) => { if (key) addSystemLine(vocab[key]); },
  });
  const { text, setText, uploads } = composer;

  // ── local UI state ──
  const [moreOpen, setMoreOpen] = useState(false);
  const [sessionIdOpen, setSessionIdOpen] = useState(false);
  const [sessionStatsOpen, setSessionStatsOpen] = useState(false);
  useEffect(() => {
    setMoreOpen(false); setSessionIdOpen(false); setSessionStatsOpen(false);
  }, [sessionId]);
  const [originalSheet, setOriginalSheet] = useState<{ text: string } | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [contextUsageOpen, setContextUsageOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickFiles = (accept: string, capture?: string): void => {
    const el = fileInputRef.current;
    if (!el) return;
    el.accept = accept;
    if (capture) el.setAttribute('capture', capture);
    else el.removeAttribute('capture');
    el.click();
  };

  // ── edit (7b) and interaction routing (5a/5b) both take the composer over before a send ──
  const edit = useMobileMessageEdit({
    rows, running: chat.running, text, setText, rewind: chat.rewind, onStart: () => routing.disarmReject(),
  });
  const routing = useMobileInteractions({
    rows, sessionId, actions: chat.interactionActions, editing: edit.armed, setText,
  });
  const typed = !!text.trim() && !uploads.hasNonDone;
  const sendEnabled = edit.armed
    ? typed && !chat.rewind.pending
    : routing.rejectArmed || routing.answering
      ? typed && !chat.interactionActions.busy
      : composer.canSend;
  const onSend = (): void => {
    if (!edit.armed && !routing.rejectArmed && !routing.answering) { composer.submit(); return; }
    if (!sendEnabled) return;
    if (edit.armed) edit.submit(text.trim());
    else routing.submit(text.trim());
  };

  // Whole-session totals — the ⋯ menu's「会话统计」sheet. Same vm as desktop; only `summary` goes
  // unused here, because the mobile header line has no room for a second segment.
  const sessionStats = useMemo(
    () => sessionStatsView(active?.totals ?? null, sessionSpanMs(active?.createdAt, active?.lastUsedAt), {
      scope: vocab.wbSessionScope, turnsUnit: vocab.wbTurnsUnit, runsUnit: vocab.wbRunsUnit,
      runsLabel: vocab.wbStatRuns, turnsLabel: vocab.wbStatTurns, activeLabel: vocab.wbStatActive,
      spanLabel: vocab.wbStatSpan, costLabel: vocab.wbStatCost, subagentLabel: vocab.wbStatSubagent,
    }, lang),
    [active?.totals, active?.createdAt, active?.lastUsedAt, vocab, lang],
  );
  // A pending interaction outranks everything; then the shared run line (browser start-up first).
  const runLine = runStatusLine({
    isDraft, running: chat.running, backgroundRunning: chat.backgroundRunning,
    starting: chat.pendingUser.length > 0, turns: chat.turns, cost: active?.costUsd ?? null,
    turnClock: chat.turnClock, waitingOn: active?.waitingOn ?? 0,
    browserDevice: active?.browser?.device ?? draftBrowserDevice,
    turnProgressStarted: chat.liveTurns !== null || chat.streaming,
  }, vocab, lang);
  const status: ChatHeaderStatus = routing.headerStatus
    ?? { running: runLine.active, tone: runLine.active ? 'running' : 'idle', text: runLine.text, liveText: runLine.liveText };
  const title = isDraft
    ? vocab.newSession
    : (active ? sessionDisplayTitle(active, chat.runTitle) : route.routeParam ?? '');
  // 8d hint above the composer: replying extracts the run into a normal session.
  const schedHint = chat.isScheduledRun ? vocab.chatScheduledHint : null;
  const chipParts = selectionChipParts(selection.effective);
  const agentChip = agentChipParts(selection.agentOptions, selection.agentName);
  const attachmentsVM: PendingAttachmentVM[] = uploads.items.map((upload) => {
    const type = attachmentType(upload);
    return {
      id: upload.id,
      name: upload.file?.name ?? upload.meta?.name ?? vocab.chatFileFallback,
      progress: upload.progress,
      status: upload.status,
      type: type === 'image' || type === 'video' ? type : 'file',
      previewUrl: upload.previewUrl,
    };
  });

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) uploads.addFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <MChatView
        title={title}
        parent={team.lead ? { title: sessionDisplayTitle(team.lead, null), onSelect: () => navigate(`/m/session/${team.lead!.sessionId}`) } : null}
        workers={team.workers}
        onOpenWorker={(id) => navigate(`/m/session/${id}`)}
        metadataSession={!isDraft && active ? { sessionId: active.sessionId, title, starred: active.starred } : null}
        status={status}
        project={route.projectId ?? undefined}
        rows={rows}
        loading={!!sessionId && chat.transcriptPending}
        copy={vocab}
        onBack={() => navigate('/m/sessions')}
        moreOpen={moreOpen}
        onMoreToggle={() => setMoreOpen((o) => !o)}
        onMoreClose={() => setMoreOpen(false)}
        sessionIdOpen={sessionIdOpen}
        onSessionIdOpen={() => setSessionIdOpen(true)}
        onSessionIdClose={() => setSessionIdOpen(false)}
        sessionStatsRows={sessionStats?.rows ?? null}
        sessionStatsOpen={sessionStatsOpen}
        onSessionStatsOpen={() => setSessionStatsOpen(true)}
        onSessionStatsClose={() => setSessionStatsOpen(false)}
        cortexId={active?.name ?? null}
        backendUuid={active?.backendSessionId ?? null}
        systemLines={schedHint ? [...systemLines, schedHint] : systemLines}
        interactions={routing.interactions}
        rejectBar={routing.rejectBar}
        editCopy={vocab}
        msgMenu={edit.msgMenu}
        onLongPress={edit.hold}
        editing={edit.editing}
        onShowOriginal={(edited) => setOriginalSheet({ text: edited.originalText })}
        originalSheet={originalSheet ? { text: originalSheet.text, onClose: () => setOriginalSheet(null) } : null}
        streamKey={sessionId}
        sessionId={sessionId}
        todos={chat.todos}
        railLang={lang}
        waitpoints={chat.waitpoints}
        composerValue={text}
        onComposerChange={setText}
        onSend={onSend}
        slashSuggestions={edit.armed || routing.rejectArmed || routing.answering ? [] : composer.slashSuggestions}
        onSlashPick={(suggestion) => { composer.pickSlash(suggestion); }}
        sendEnabled={sendEnabled}
        composerPlaceholder={routing.placeholder}
        onStop={composer.stop}
        stopEnabled={!composer.stopPending}
        selectionChipLabel={chipParts.main}
        selectionChipSub={chipParts.sub}
        browserDevice={isDraft ? draftBrowserDevice : (active?.browser?.device ?? null)}
        onOpenBrowser={isDraft ? () => setBrowserSheetOpen(true) : undefined}
        browserSheet={browserSheetOpen ? {
          items: browserOptions,
          title: vocab.wbBrowser,
          onClose: () => setBrowserSheetOpen(false),
          onPick: (device: string | null) => { setDraftBrowserDevice(device); setBrowserSheetOpen(false); },
        } : undefined}
        commissionValue={isDraft
          ? (commissionEnabled ? draftCommission : null)
          : (sessionCommission?.value ?? null)}
        commissionLabel={isDraft
          ? (commissionEnabled
            ? (draftCommission === 'new' ? vocab.wbCommissionNewOption : draftCommissionTitle)
            : null)
          : (sessionCommission?.label ?? (sessionCommission ? vocab.wbCommissionUnnamed : null))}
        onOpenCommission={isDraft && commissionEnabled ? () => setCommissionSheetOpen(true) : undefined}
        commissionSheet={commissionSheetOpen ? {
          items: commissionOptions.map((o) => ({ value: o.value, label: o.label, sub: o.sub })),
          title: vocab.wbCommissionMode,
          onClose: () => setCommissionSheetOpen(false),
          onPick: (value: string | null) => { setDraftCommission(value); setCommissionSheetOpen(false); },
        } : undefined}
        onOpenSelection={() => selection.setOpen(true)}
        agentChip={hasAgentChoice(selection.agents)
          ? { label: agentChip.name ?? vocab.wbAgentDefault, followingDefault: agentChip.followingDefault }
          : null}
        onOpenAgent={() => selection.setAgentOpen(true)}
        contextUsage={chat.contextUsage}
        contextUsageSupported={!!active?.contextCompactionSupported}
        contextCompactAction={chat.compactAction}
        contextUsageOpen={contextUsageOpen}
        onContextUsageOpen={() => setContextUsageOpen(true)}
        onContextUsageClose={() => setContextUsageOpen(false)}
        attachments={attachmentsVM}
        onRemoveAttachment={uploads.remove}
        onRetryAttachment={uploads.retry}
        onPlus={() => setAttachMenuOpen((o) => !o)}
        attachMenuOpen={attachMenuOpen}
        onAttachClose={() => setAttachMenuOpen(false)}
        onCamera={() => pickFiles('image/*', 'environment')}
        onLibrary={() => pickFiles('image/*,video/*')}
        onFile={() => pickFiles('*/*')}
        selectionSheet={
          selection.open
            ? {
              vm: buildSelectionSheet({
                profiles: selection.profiles,
                catalog: selection.catalog,
                effective: selection.effective,
                override: selection.override,
                hasHistory: selection.hasHistory,
                defaultProfile: selection.defaultProfile,
                copy: {
                  profile: vocab.chatProfileTitle,
                  model: vocab.wbModel,
                  thinking: vocab.wbThinking,
                  mode: vocab.wbRoute,
                  followProfile: vocab.wbFollowProfile,
                  followAll: vocab.wbFollowAll,
                  hiddenModels: vocab.wbHiddenModels,
                  hiddenProfiles: vocab.wbHiddenProfiles,
                  hiddenNoProfile: vocab.wbHiddenNoProfile,
                },
              }),
              pending: selection.catalogLoading || !selection.modelsReady,
              onClose: () => selection.setOpen(false),
              onPick: onPickSelection,
            }
            : undefined
        }
        agentSheet={
          selection.agentOpen && hasAgentChoice(selection.agents)
            ? {
              rows: buildAgentSheet({
                agents: selection.agents,
                profiles: selection.profiles,
                agentName: selection.agentName,
                currentBackend: selection.effective.backend,
                hasHistory: selection.hasHistory,
                copy: {
                  agentDefault: vocab.wbAgentDefault,
                  agentFollowDefault: vocab.wbAgentFollowDefault,
                  agentCrossBackend: vocab.wbAgentCrossBackend,
                },
              }),
              title: vocab.wbAgent,
              onClose: () => selection.setAgentOpen(false),
              onPick: onPickSelection,
            }
            : undefined
        }
      />
    </>
  );
}
