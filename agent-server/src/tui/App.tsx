import React, { useCallback, useRef, useState, useEffect } from 'react';
import { Box, useStdout } from 'ink';
import { Transcript } from './components/Transcript.js';
import { InputBox } from './components/InputBox.js';
import { StatusLine } from './components/StatusLine.js';
import { SidePanel } from './components/SidePanel.js';
import { NotificationsModal } from './components/Notifications.js';
import { ProjectSwitcher } from './components/ProjectSwitcher.js';
import { useMutate } from './hooks/useMutate.js';
import type { MutateResult } from './hooks/useMutate.js';
import { useTranscript } from './hooks/useTranscript.js';
import { useKeybindings } from './hooks/useKeybindings.js';
import { useMouseHandler } from './hooks/useMouseHandler.js';
import type { SelectionRange } from './hooks/useMouseHandler.js';
import { osc52Copy, normalizeSelection, extractSelectionText } from './logic.js';
import { useNotifications } from './hooks/useNotifications.js';
import type { NotificationEntry } from './hooks/useNotifications.js';
import { useDashboardData } from './hooks/useDashboardData.js';
import { SessionPicker } from './components/SessionPicker.js';
import { SLASH_COMMANDS } from './slash-commands.js';
import { AskUserModal } from './components/AskUserModal.js';
import type { ResumableSession } from './components/SessionPicker.js';
import { isNotification, isUiQueryResult, isUiEvent, isModalOpen, isModalAck, isErrorFrame, isChatPost, isChatUpdate } from '../platform/tui/protocol.js';
import { computeFocusZone, isAgentResponseFrame, matchResumeTarget } from './logic.js';
import { parseTurnStatus, formatTurnStatus } from './turn-status.js';
import type { WsState } from './ws-client.js';
import type { TuiFrame, HandshakeAck, ModalOpen, ModalAck } from '../platform/tui/protocol.js';
import type { ProjectEntry } from './components/ProjectSwitcher.js';
import { t, setLocale } from '../core/i18n.js';

// ── Types ──

export interface AppProps {
  sendFrame: (frame: TuiFrame) => void;
  connectionState: WsState;
  ack: HandshakeAck | null;
  onReconnect: () => void;
  onDisconnect: () => void;
  onSendCancel: () => void;
  serverVersion: string | null;
  projectId: string | null;
  sessionName: string | null;
  /** Fatal/connection error surfaced from the entry layer (e.g. backoff cap exceeded). */
  errorMessage?: string | null;
  /**
   * Called when this App component is ready to receive frames for dispatch.
   * The parent (index.tsx) calls this function for each WS frame.
   */
  onSetDispatch?: (dispatch: (frame: TuiFrame) => void) => void;

  // Resume mode — interactive session picker
  resumableSessions?: ResumableSession[] | null;
  resumePending?: boolean;
  onResumeSelect?: (sessionId: string, projectId: string) => void;
  onResumeCancel?: () => void;
}

/** A status message is the only TUI chat content that carries an `actions` rich-block. */
function hasActionsBlock(content: { richBlocks?: Array<{ type?: string }> } | undefined): boolean {
  return !!content?.richBlocks?.some(b => b?.type === 'actions');
}

export function App({
  sendFrame,
  connectionState,
  ack,
  onReconnect,
  onDisconnect,
  onSendCancel,
  serverVersion,
  projectId,
  sessionName,
  errorMessage,
  onSetDispatch,
  resumableSessions,
  resumePending,
  onResumeSelect,
  onResumeCancel,
}: AppProps): React.JSX.Element {
  // ── Hooks ──
  const [activeModal, setActiveModal] = useState<ModalOpen | null>(null);
  const [modalAckErrors, setModalAckErrors] = useState<Record<string, string>>({});

  const transcript = useTranscript({
    onModalOpen: useCallback((frame: ModalOpen) => {
      setActiveModal(frame);
      setModalAckErrors({});
    }, []),
    onModalAck: useCallback((frame: ModalAck) => {
      if (frame.errors && Object.keys(frame.errors).length > 0) {
        setModalAckErrors(frame.errors);
      } else {
        setActiveModal(null);
        setModalAckErrors({});
      }
    }, []),
  });
  const notif = useNotifications();
  const dashboard = useDashboardData();

  const [queuedCount, setQueuedCount] = useState(0);
  // The user can always type; awaitingResponse only blocks *sending* until the
  // agent starts replying (no explicit turn-end frame exists in the protocol).
  const [awaitingResponse, setAwaitingResponse] = useState(false);

  // Phase 2 state
  const [sidePanelVisible, setSidePanelVisible] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);

  // Bottom-line shortcuts overlay — '?' on an empty input shows it; any key dismisses it.
  const [showShortcuts, setShowShortcuts] = useState(false);
  // Stable callbacks so the memoized InputBox isn't re-rendered by unrelated App state changes.
  const handleToggleShortcuts = useCallback(() => setShowShortcuts(s => !s), []);
  const handleDismissShortcuts = useCallback(() => setShowShortcuts(false), []);

  // Mouse capture (SGR tracking) state. Default ON so the wheel scrolls the transcript (enabled at
  // startup in index.tsx). Ctrl+T / `/mouse` toggles it OFF — writing the SGR disable sequence —
  // to free the mouse for native click-drag text selection + right-click paste (the wheel stops).
  const [mouseCapture, setMouseCapture] = useState(true);

  // Toast message (e.g. "Copied to clipboard!") — auto-clears after 3 seconds.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => { setToast(null); toastTimerRef.current = null; }, 3000);
  }, []);

  // Project switcher state
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  // `/resume` session picker (client-side, replaces the inert Resume button).
  const [slashResumeSessions, setSlashResumeSessions] = useState<ResumableSession[] | null>(null);
  // `/resume <id>` direct-jump target (session id / name / suffix). Resolved against the
  // sessions.list result; null means "show the picker".
  const resumeTargetRef = useRef<string | null>(null);

  // Dedicated turn-status line shown above the input (state/time/turns/cost). Status
  // frames (identified by their `actions` rich-block) are routed here, NOT the transcript.
  const [turnStatus, setTurnStatus] = useState<string | null>(null);

  const transcriptRef = useRef<{ scrollUp: (page?: boolean) => void; scrollDown: (page?: boolean) => void; scrollByLines: (delta: number) => void; scrollToEnd: () => void; getSelectedText: (range: SelectionRange) => string } | null>(null);

  // Terminal size — drives the full-screen root box and updates on resize so the layout
  // always fills the alternate-screen buffer (see enterFullscreen in index.tsx).
  const { stdout } = useStdout();
  const [termSize, setTermSize] = useState<{ rows: number; columns: number }>(() => ({
    rows: stdout?.rows ?? 24,
    columns: stdout?.columns ?? 80,
  }));
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setTermSize({ rows: stdout.rows, columns: stdout.columns });
    onResize();
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  // Active tab for dashboard
  const [activeTab, setActiveTab] = useState('threads');

  // Route non-mutate frames to the appropriate handler
  const routeFrame = useCallback((frame: TuiFrame) => {
    // Any agent reply / stream frame means the turn is being answered — unblock
    // sending and clear the queued counter (there is no explicit turn-end frame).
    // An error frame also releases the lock so a failed turn never strands input.
    if (isAgentResponseFrame(frame) || isErrorFrame(frame)) {
      setAwaitingResponse(false);
      setQueuedCount(0);
    }
    if (isNotification(frame)) {
      notif.add(frame);
      return;
    }
    if (isUiQueryResult(frame) || isUiEvent(frame)) {
      // Handle the `/resume` session list
      if (isUiQueryResult(frame) && frame.id === 'slash-resume-list') {
        const list = (frame.ok && Array.isArray(frame.data))
          ? (frame.data as any[]).map((s: any) => ({
              sessionId: s.sessionId ?? s.id,
              name: s.name,
              projectId: s.projectId,
              label: s.label ?? null,
            }))
          : [];
        // `/resume <id>`: resolve the target and jump straight in, skipping the picker.
        const target = resumeTargetRef.current;
        resumeTargetRef.current = null;
        if (target) {
          const matchedId = matchResumeTarget(list, target);
          if (matchedId) {
            const matched = list.find(s => s.sessionId === matchedId);
            sendFrame({
              type: 'session.switch',
              id: 'slash-resume-direct',
              projectId: matched?.projectId ?? projectId ?? 'general',
              sessionId: matchedId,
            } as any);
            setSlashResumeSessions(null);
            return;
          }
          // No match — fall through to the picker so the user can choose.
        }
        setSlashResumeSessions(list);
        return;
      }
      // Handle project switcher responses
      if (isUiQueryResult(frame) && frame.id === 'proj-switcher-list') {
        if (frame.ok) {
          setProjects(Array.isArray(frame.data) ? frame.data as ProjectEntry[] : []);
          setProjectsLoading(false);
          setProjectsError(null);
        } else {
          setProjects([]);
          setProjectsLoading(false);
          setProjectsError((frame as any).error?.message ?? t('tui.projects.loadFailed'));
        }
        return;
      }
      dashboard.dispatch(frame);
      return;
    }
    // Status messages (the "⏳ Processing…/✅ Done…" line) carry an `actions` rich-block.
    // Route them to the dedicated turn-status line above the input instead of the
    // transcript, so the chat history holds only real user/assistant messages.
    if ((isChatPost(frame) || isChatUpdate(frame)) && hasActionsBlock((frame as any).content)) {
      const text = String((frame as any).content?.text ?? '');
      setTurnStatus(text ? formatTurnStatus(parseTurnStatus(text)) : null);
      return;
    }
    transcript.dispatch(frame);
  }, [transcript.dispatch, dashboard.dispatch, notif.add, sendFrame, projectId]);

  // Mutate hook: sends ui.mutate frames, correlates results by id, 10s timeout
  const { mutate, handleFrame } = useMutate({ sendFrame, onFrame: routeFrame });

  // Combined dispatch: mutate intercepts mutateResult; rest routes normally
  useEffect(() => {
    onSetDispatch?.((frame: TuiFrame) => { handleFrame(frame); });
  }, [onSetDispatch, handleFrame]);

  // Send initial cost query for header summary
  useEffect(() => {
    sendFrame({ type: 'ui.query', id: 'dash-cost', scope: 'cost.summary', params: {} } as any);
  }, []);

  // Switching project/session (session.switched is handled in index.tsx and never reaches
  // routeFrame) must release any pending send-lock from the OLD session. With lazy session
  // creation the first message transitions sessionName null→name — that is NOT a switch and
  // must NOT clear the in-flight `awaitingResponse`/queued state, so we only reset when a real
  // prior session existed and actually changed.
  const prevSessionRef = useRef<{ projectId: string | null; sessionName: string | null }>({ projectId, sessionName });
  useEffect(() => {
    const prev = prevSessionRef.current;
    const isRealSwitch = (prev.sessionName !== null && prev.sessionName !== sessionName)
      || (prev.projectId !== null && prev.projectId !== projectId);
    prevSessionRef.current = { projectId, sessionName };
    if (isRealSwitch) {
      setAwaitingResponse(false);
      setQueuedCount(0);
    }
  }, [projectId, sessionName]);

  // Submit message
  const handleSubmit = useCallback((text: string) => {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sendFrame({
      type: 'msg.user',
      id,
      text,
    } as any);
    // Optimistically echo genuine user messages into the transcript (the server doesn't echo
    // them back). Skip `!`-prefixed control commands (!new/!cancel/!restart…) — they aren't chat.
    if (text && !text.startsWith('!')) {
      transcript.addUserMessage(text);
    }
    setQueuedCount(prev => prev + 1);
    setAwaitingResponse(true);
  }, [sendFrame, transcript]);

  // Cancel (sends !cancel)
  const handleCancel = useCallback(() => {
    onSendCancel();
  }, [onSendCancel]);

  // Clear view
  const handleClearView = useCallback(() => {
    transcript.clear();
  }, [transcript]);

  // Scroll
  const handleScrollUp = useCallback((page?: boolean) => {
    transcriptRef.current?.scrollUp(page);
  }, []);

  const handleScrollDown = useCallback((page?: boolean) => {
    transcriptRef.current?.scrollDown(page);
  }, []);

  // Coalesced wheel scroll: a batched net delta from useMouseHandler applied in one update.
  const handleScrollByLines = useCallback((delta: number) => {
    transcriptRef.current?.scrollByLines(delta);
  }, []);

  // Side panel toggle
  const handleToggleSidePanel = useCallback(() => {
    setSidePanelVisible(prev => !prev);
  }, []);

  // Notifications toggle
  const handleToggleNotifications = useCallback(() => {
    setNotificationsOpen(prev => !prev);
  }, []);

  // Project switcher toggle
  const handleToggleProjectSwitcher = useCallback(() => {
    setProjectSwitcherOpen(prev => !prev);
  }, []);

  // Toggle mouse capture. Writes the SGR mouse enable/disable sequences straight to the TTY so
  // the change takes effect immediately: OFF frees the mouse for native text selection, ON
  // restores wheel-scroll + in-TUI drag-select capture. ?1002h = button-event tracking (motion
  // only while a button is held), ?1006h = SGR encoding. index.tsx's leaveFullscreen disables
  // tracking on exit anyway.
  const handleToggleMouse = useCallback(() => {
    setMouseCapture(prev => {
      const next = !prev;
      try { process.stdout.write(next ? '\x1b[?1002h\x1b[?1006h' : '\x1b[?1002l\x1b[?1006l'); } catch { /* best effort */ }
      return next;
    });
  }, []);

  // Project switcher select
  const handleProjectSelect = useCallback((selectedProjectId: string) => {
    sendFrame({
      type: 'session.switch',
      id: 'proj-switch',
      projectId: selectedProjectId,
      sessionId: null,
    } as any);
  }, [sendFrame]);

  // Notification select — switches to notification's project
  const handleNotificationSelect = useCallback((notif: NotificationEntry) => {
    sendFrame({
      type: 'session.switch',
      id: 'notif-switch',
      projectId: notif.projectId,
      sessionId: notif.sessionId ?? null,
    } as any);
    setNotificationsOpen(false);
  }, [sendFrame]);

  // Project switcher refresh
  const handleProjectsRefresh = useCallback(() => {
    setProjectsLoading(true);
    setProjectsError(null);
    sendFrame({
      type: 'ui.query',
      id: 'proj-switcher-list',
      scope: 'projects.list',
      params: {},
    } as any);
  }, [sendFrame]);

  // Slash-command dispatch from the input palette.
  const handleCommand = useCallback((name: string, args: string) => {
    switch (name) {
      case 'new':
        // Clear the view, then start a new conversation (server runs the pre-close hook).
        handleClearView();
        handleSubmit('!new');
        break;
      case 'newx':
        // Same, but skip the pre-close hook (no save).
        handleClearView();
        handleSubmit('!newq');
        break;
      case 'cancel':
        handleCancel();
        break;
      case 'restart':
        // Send the server-restart command. The WS connection drops during the respawn
        // and the client reconnects automatically (no need to keep the input locked).
        handleSubmit('!restart');
        break;
      case 'resume':
        // `/resume` opens the picker; `/resume <id>` jumps straight to that session.
        resumeTargetRef.current = args.trim() || null;
        sendFrame({ type: 'ui.query', id: 'slash-resume-list', scope: 'sessions.list', params: { resumable: true } } as any);
        break;
      case 'mouse':
        // Client-side only (the server has no !mouse): toggle mouse capture for text selection.
        handleToggleMouse();
        break;
      case 'help':
        // The palette itself lists the commands — nothing else to do.
        break;
      case 'lang': {
        // The server persists + applies the switch; mirror it in this process so the TUI's own
        // text follows immediately (it only reads preferences.json at startup).
        const lang = args.trim().toLowerCase();
        if (lang === 'en' || lang === 'zh') setLocale(lang);
        handleSubmit(`!lang${args ? ` ${args}` : ''}`);
        break;
      }
      default:
        // Every other registered slash command mirrors a server `!` command (same name). Forward
        // it as `!<name> <args>` so the server's command dispatcher handles it and replies into
        // the transcript. `!`-prefixed text is not echoed as a chat message (see handleSubmit).
        handleSubmit(`!${name}${args ? ` ${args}` : ''}`);
        break;
    }
  }, [handleClearView, handleSubmit, handleCancel, handleToggleMouse, sendFrame]);

  // `/resume` picker selection → switch to the chosen session; Esc/cancel closes it.
  const handleSlashResumeSelect = useCallback((sessionId: string, pickedProjectId: string) => {
    sendFrame({ type: 'session.switch', id: 'slash-resume', projectId: pickedProjectId, sessionId } as any);
    setSlashResumeSessions(null);
  }, [sendFrame]);

  const handleSlashResumeCancel = useCallback(() => {
    setSlashResumeSessions(null);
  }, []);

  // Modals pre-empt input; an open dashboard takes keyboard focus from the input.
  const modalOpen = activeModal !== null || notificationsOpen || projectSwitcherOpen || slashResumeSessions !== null;
  const focusZone = computeFocusZone({ modalOpen, sidePanelVisible });

  // Keyboard bindings — toggles/cancel always active outside modals; scroll only
  // when the chat input owns focus; reconnect only when not connected.
  useKeybindings({
    onSubmit: handleSubmit,
    onCancel: handleCancel,
    onScrollUp: handleScrollUp,
    onScrollDown: handleScrollDown,
    onClearView: handleClearView,
    onExit: onDisconnect,
    onToggleSidePanel: handleToggleSidePanel,
    onToggleNotifications: handleToggleNotifications,
    onToggleProjectSwitcher: handleToggleProjectSwitcher,
    onToggleMouse: handleToggleMouse,
    onReconnect,
  }, focusZone !== 'modal', {
    allowScroll: focusZone === 'input',
    allowReconnect: connectionState !== 'connected',
  });

  // Mouse handler: wheel scroll, text selection (left-drag → OSC 52 copy), right-click hint.
  const handleSelectionComplete = useCallback((range: SelectionRange) => {
    const text = transcriptRef.current?.getSelectedText(range);
    if (text && text.length > 0) {
      osc52Copy(text);
      showToast(t('tui.app.copied', { n: text.length }));
    }
  }, [showToast]);

  const handleRightClick = useCallback(() => {
    showToast(t('tui.app.pasteHint'));
  }, [showToast]);

  const { selection } = useMouseHandler({
    onScrollUp: handleScrollUp,
    onScrollDown: handleScrollDown,
    onScrollByLines: handleScrollByLines,
    onSelectionComplete: handleSelectionComplete,
    onRightClick: handleRightClick,
  });

  // Dashboard subscription management callbacks. Depend on the stable inner
  // functions (each a useCallback in useDashboardData), NOT the whole `dashboard`
  // object — that object is recreated every render, which previously made these
  // wrappers (and thus the Dashboard effect deps) change identity on every render.
  const { registerSubscription, unregisterSubscription } = dashboard;
  const handleRegisterSubscription = useCallback((queryId: string, tab: string) => {
    registerSubscription(queryId, tab as any);
  }, [registerSubscription]);

  const handleUnregisterSubscription = useCallback((queryId: string) => {
    unregisterSubscription(queryId);
  }, [unregisterSubscription]);

  // Compute the actual reserved rows for the bottom UI so Transcript sizes its viewport exactly.
  // Base = marginTop(1) + border(3) + StatusLine(1) = 5, plus the optional line above the input
  // (toast OR turn-status — InputBox renders one or the other) and the awaiting-response hint.
  const reservedBottomRows = 5 + ((toast || turnStatus) ? 1 : 0) + (awaitingResponse && focusZone === 'input' ? 1 : 0);

  // If resume mode with sessions to pick, show picker instead of main layout
  if (resumableSessions && resumableSessions.length > 0 && onResumeSelect && onResumeCancel) {
    return (
      <Box flexDirection="column" height={termSize.rows} width={termSize.columns} justifyContent="center" alignItems="center">
        <SessionPicker
          sessions={resumableSessions}
          onSelect={onResumeSelect}
          onCancel={onResumeCancel}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={termSize.rows} width={termSize.columns}>
      {/* Main area. When the dashboard is open it takes over this row, horizontally centered
          (justifyContent="center"); the transcript is hidden so the dashboard reads as a centered
          card. Otherwise the transcript fills the width. */}
      <Box flexDirection="row" flexGrow={1} justifyContent="center">
        {sidePanelVisible ? (
          <SidePanel
            visible={sidePanelVisible}
            active={focusZone === 'dashboard'}
            sendFrame={sendFrame}
            projectId={projectId}
            dashState={dashboard.state}
            onRegisterSubscription={handleRegisterSubscription}
            onUnregisterSubscription={handleUnregisterSubscription}
            activeTab={activeTab}
            onSetActiveTab={setActiveTab}
            onMutate={mutate}
            onClose={handleToggleSidePanel}
          />
        ) : (
          <Box flexDirection="column" flexGrow={1}>
            <Transcript
              ref={transcriptRef}
              messages={transcript.messages}
              ids={transcript.ids}
              reservedRows={reservedBottomRows}
              selection={selection}
            />
          </Box>
        )}
      </Box>

      {/* Turn status (state · time · turns · cost) is rendered by InputBox, tight above the
          input border — see the statusLine prop below. */}

      {/* Input area */}
      {/* AskUserModal — pre-empts all other modals */}
      {activeModal ? (
        <AskUserModal
          modal={activeModal.modal}
          triggerId={activeModal.triggerId}
          sendFrame={sendFrame}
          ackErrors={modalAckErrors}
          onClose={() => { setActiveModal(null); setModalAckErrors({}); }}
        />
      ) : modalOpen ? (
        <Box borderStyle="single" borderDimColor paddingX={1} marginTop={1}>
          {notificationsOpen ? (
            <NotificationsModal
              open={notificationsOpen}
              notifications={notif.notifications}
              ids={notif.ids}
              onMarkRead={notif.markRead}
              onClose={() => setNotificationsOpen(false)}
              onSelect={handleNotificationSelect}
            />
          ) : null}
          {projectSwitcherOpen ? (
            <ProjectSwitcher
              open={projectSwitcherOpen}
              projects={projects}
              loading={projectsLoading}
              error={projectsError}
              onSelect={handleProjectSelect}
              onClose={() => setProjectSwitcherOpen(false)}
              onRequestRefresh={handleProjectsRefresh}
            />
          ) : null}
          {slashResumeSessions !== null ? (
            <SessionPicker
              sessions={slashResumeSessions}
              onSelect={handleSlashResumeSelect}
              onCancel={handleSlashResumeCancel}
            />
          ) : null}
        </Box>
      ) : (
        <InputBox
          onSubmit={handleSubmit}
          onCommand={handleCommand}
          commands={SLASH_COMMANDS}
          awaitingResponse={awaitingResponse}
          focus={focusZone === 'input'}
          showShortcuts={showShortcuts}
          onToggleShortcuts={handleToggleShortcuts}
          onDismissShortcuts={handleDismissShortcuts}
          statusLine={turnStatus}
          toast={toast}
        />
      )}

      <StatusLine
        connectionState={connectionState}
        errorMessage={errorMessage}
        projectId={projectId}
        queuedCount={queuedCount}
        notificationCount={notif.unreadCount}
        showShortcuts={showShortcuts && focusZone === 'input'}
        dashboardActive={focusZone === 'dashboard'}
        mouseCapture={mouseCapture}
      />
    </Box>
  );
}
