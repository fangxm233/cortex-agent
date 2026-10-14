import { MENU_FOCUS } from '@/design/MenuChrome';
import {
  useRef, useState, useCallback, useEffect, useLayoutEffect, useMemo,
  type ReactNode, type RefObject,
} from 'react';
import { useLang, useVocab } from '@/i18n';
import type { SlashSuggestion } from '@/features/session/composer/composer-slash';
import { useSelectedSession } from '@/features/session/state/SelectedSessionProvider';
import { DRAFT_SENTINEL } from '@/features/session/state/selected-session';
import { useComposerSend, type SlashFeedbackKey } from '@/features/session/chat/useComposerSend';
import { runStatusLine } from '@/features/session/chat/run-status-line';
import { useSessionSelection } from '@/features/session/composer/useSessionSelection';
import type { OptimisticUserMessages } from '@/features/session/transcript/useOptimisticUserMessages';
import { ComposerStatusLine } from './ComposerStatusLine';
import { SessionStatsModal } from './SessionStatsModal';
import { sessionStatsView } from '@/features/session/list/session-stats';
import { ComposerSendFailure } from './ComposerSendFailure';
import { ComposerAttachmentChip } from './ComposerAttachmentChip';
import { TodoRail } from '@/features/session/rail/TodoRail';
import { WaitRail } from '@/features/session/rail/WaitRail';
import type { SessionWaitpoints } from '@/features/session/live/useSessionWaitpoints';
import {
  ComposerActionRow, ComposerSlashMenu,
  type ComposerBrowserControl,
} from './ComposerActionRow';
import { AgentSelectorView, SessionSelectorView } from './SessionSelector';
import type { ContextCompactAction } from '@/features/session/composer/ContextUsageControl';
import type { SessionSelectionOverride, SessionTotals, TodoSnapshot } from '@cortex-agent/ui-contract';
import type { TurnClock } from '@/features/session/transcript/transcript-vm';
import { DraftProjectSelector } from './DraftProjectSelector';
import { useFileDropTarget } from './useFileDropTarget';
import { ChatDropOverlay } from './ChatDropOverlay';

// Composer — a unified card: full-width input on top, one toolbar row below. The toolbar keeps the
// ＋ menu (attach · browser opt-in · local slash commands) on the left and the profile chip, context
// ring and Send/Stop cluster on the right.
// Three entry points for files: ＋ menu "attach" · paste (clipboard images) · drag & drop.
// Files upload to the server's tmp/attachments/<sessionId>/ and are referenced by path.
// Attachment chips show type badges, filenames, sizes, upload progress, and remove buttons.
// The send button enables when text is non-empty OR uploaded attachments are present.

// Auto-grow cap: ~15 lines at 13.5px × 1.5 line-height (≈20.25px/line), then internal scroll.
const COMPOSER_MAX_HEIGHT = 305;

export interface ComposerProps {
  sessionId: string;
  running: boolean;
  /** Foreground turn ended but a background task is still running (web bg-hold). `running` stays
   *  true; this only re-labels the running line "background" so the user knows the turn's own
   *  reply is done while background work continues. */
  backgroundRunning?: boolean;
  /** Armed waitpoints this session is waiting on (SessionInfo.waitingOn). Shown as an extra status
   *  segment so an idle session that is actually waiting for a machine does not read as plain idle. */
  waitingOn?: number;
  /** Real agent-turn count (snapshot + `session.turn` delta); null when unknown → rendered as —. */
  turns: number | null;
  /** Last run's total cost in USD (SessionInfo.costUsd snapshot); null while running / never-ran → —. */
  cost: number | null;
  /** Current turn's clock; ticks live while `running`, else renders the settled span. */
  turnClock: TurnClock | null;
  /** WHOLE-SESSION totals (SessionInfo.totals). The three fields above describe the current/last
   *  run only; this is the cumulative counterpart rendered as the status line's second segment.
   *  Null on a session that has never finished a run — the segment is then absent entirely. */
  totals?: SessionTotals | null;
  /** Wall-clock lifetime of the session, for the detail modal's "open since" row. */
  sessionSpanMs?: number | null;
  isDraft?: boolean;
  /** Browser control an EXISTING session was created with. Read-only — fixed at spawn. */
  sessionBrowser?: { device: string } | null;
  currentProfile: string | null;
  /** The session's model/thinking choice on top of that profile, from its sessions.list row. */
  currentOverride?: SessionSelectionOverride | null;
  /** The agent it runs in, from that same row. Null = it follows the host's default. */
  currentAgent?: string | null;
  hasHistory: boolean;
  projectId?: string;
  /** The chat's optimistic sends: a send shows its row before the server answers, and a locally
   *  queued message reads as running before the authoritative session event arrives. */
  optimistic: Pick<OptimisticUserMessages, 'pendingUser' | 'prepare' | 'enqueue' | 'accept' | 'reject'>;
  /** The untouched New Session hides status until its first optimistic message appears. */
  showStatus?: boolean;
  /** True after this turn emits its first agent progress or streamed output. */
  turnProgressStarted?: boolean;
  /** Context-usage ring (modal trigger), rendered in the toolbar right cluster beside the profile. */
  contextControl?: ReactNode;
  todos?: TodoSnapshot | null;
  /** What this session is waiting on from outside Cortex, and how to cancel one. Supplied by the
   *  host (useSessionWaitpoints) rather than fetched here — see WaitRail. */
  waitpoints?: SessionWaitpoints | null;
  compactAction?: ContextCompactAction;
  /** The larger surface that accepts file drops for this composer. */
  dropTargetRef: RefObject<HTMLElement>;
  onOpenSettings?: () => void;
  onOpenUsage?: () => void;
}

export function Composer({
  sessionId,
  running,
  backgroundRunning = false,
  waitingOn = 0,
  turns,
  cost,
  turnClock,
  totals = null,
  sessionSpanMs: spanMs = null,
  isDraft = false,
  sessionBrowser = null,
  currentProfile,
  currentOverride = null,
  currentAgent = null,
  hasHistory,
  projectId = 'general',
  optimistic,
  showStatus = true,
  turnProgressStarted = false,
  contextControl,
  todos,
  waitpoints,
  compactAction,
  dropTargetRef,
  onOpenSettings = () => {},
  onOpenUsage = () => {},
}: ComposerProps): JSX.Element {
  const L = useVocab();
  const lang = useLang();
  const {
    selectCreatedSession, setSelectedSession, draftSelection, setDraftSelection, pendingCreatedSession,
    draftReloadToken,
  } = useSelectedSession();
  const engineSelection = useSessionSelection({
    sessionId, currentProfile, currentOverride, currentAgent, hasHistory, isDraft,
    draftSelection, setDraftSelection, pendingCreatedSession,
  });
  // Draft-only: the browser tool set is fixed when the agent process spawns, so this is a
  // creation-time choice, not a session setting.
  const [browserDevice, setBrowserDevice] = useState<string | null>(null);
  const [sendError, setSendError] = useState<Error | null>(null);
  const [slashErrorKey, setSlashErrorKey] = useState<SlashFeedbackKey>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [btnHover, setBtnHover] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerSend = useComposerSend({
    sessionId, isDraft, projectId, reloadToken: draftReloadToken, optimistic, running, compactAction,
    creation: {
      selection: draftSelection,
      browserDevice,
    },
    slash: {
      profileOptions: engineSelection.profileOptions,
      backend: engineSelection.effective.backend,
      agentName: engineSelection.agentName,
      onNew: () => setSelectedSession(DRAFT_SENTINEL),
      onProfile: engineSelection.pickProfile,
      onSettings: onOpenSettings,
      onUsage: onOpenUsage,
    },
    onCreated: selectCreatedSession,
    onSendFailed: setSendError,
    onSlashFeedback: setSlashErrorKey,
    onConsumed: () => {
      setSlashOpen(false);
      setSendError(null);
      if (inputRef.current) inputRef.current.style.height = 'auto';
    },
  });
  const { text: composer, setText: setComposer, uploads } = composerSend;
  useEffect(() => { setSlashErrorKey(null); }, [composer, composerSend.identity]);
  const slashSuggestions = slashOpen ? composerSend.slashSuggestions : [];
  // The highlight goes back to the first row whenever the typed text narrows or changes the list.
  const slashListKey = slashSuggestions.map((suggestion) => suggestion.command).join('\n');
  useEffect(() => { setSlashIndex(0); }, [slashListKey]);

  // Auto-grow the textarea up to a cap.
  const autoGrow = (el: HTMLTextAreaElement | null): void => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT) + 'px';
  };

  // Re-fit the textarea height whenever `composer` changes for any reason — not just
  // on keystroke (onChange). Switching sessions loads the new scope's draft via
  // setComposer(), which does NOT go through onChange, so without this the height stayed
  // frozen at the previous session's size: a multi-line draft looked collapsed to one row
  // until the user typed, and switching to an empty/new session left the box tall. Layout
  // effect runs synchronously after the value commits, before paint, so there is no flicker.
  useLayoutEffect(() => {
    autoGrow(inputRef.current);
  }, [composer]);

  const attachments = uploads.items;
  // Re-fit the textarea whenever the chip row appears/disappears: its vertical padding changes with
  // attachments (2px→11px). Pasting an image mutates `attachments` but not `composer`, so the
  // `[composer]` effect above never re-fires and the box stayed fitted to the old padding — the text
  // was clipped. Keyed on the boolean edge so it runs once per toggle, not on every chip mutation.
  const hasAttachmentsForFit = attachments.length > 0;
  useLayoutEffect(() => {
    autoGrow(inputRef.current);
  }, [hasAttachmentsForFit]);

  const addFiles = uploads.addFiles;
  const { active: dragOver, fileCount: dragFileCount } = useFileDropTarget(dropTargetRef, addFiles);

  const hasAttachments = attachments.length > 0;
  const canSend = composerSend.canSend;
  // The accent ring is the card's only state cue now that it carries no resting border: it lights up
  // when the draft is sendable, and while the slash palette is anchored to the card.
  const composerRing = canSend || slashOpen;
  const sendBg = canSend ? 'var(--proto-ink)' : 'var(--proto-line-3)';
  const statusLine = runStatusLine({
    isDraft, running, backgroundRunning, starting: optimistic.pendingUser.length > 0, turns, cost, turnClock,
    waitingOn, browserDevice: sessionBrowser?.device ?? browserDevice, turnProgressStarted,
  }, L, lang);
  // Second segment: the same three quantities for the WHOLE session. Independent of the run status —
  // totals are finalized numbers, so they stay on screen (and stay still) while a turn runs.
  const sessionStats = useMemo(
    () => sessionStatsView(totals, spanMs, {
      scope: L.wbSessionScope, turnsUnit: L.wbTurnsUnit, runsUnit: L.wbRunsUnit,
      runsLabel: L.wbStatRuns, turnsLabel: L.wbStatTurns, activeLabel: L.wbStatActive,
      spanLabel: L.wbStatSpan, costLabel: L.wbStatCost, subagentLabel: L.wbStatSubagent,
    }, lang),
    [totals, spanMs, L, lang],
  );

  // ── Paste handler ──
  const onPaste = useCallback((e: React.ClipboardEvent): void => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  }, [addFiles]);

  const doSend = composerSend.submit;
  const doStop = composerSend.stop;
  const onSlashPick = (suggestion: SlashSuggestion): void => {
    if (composerSend.pickSlash(suggestion)) setSlashOpen(true);
  };

  // ↑↓ move through the open palette, ⏎ / Tab take the highlighted row. A disabled row falls
  // through to the ordinary submit, which says why it cannot run.
  const onSlashKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (slashSuggestions.length === 0 || e.nativeEvent?.isComposing) return false;
    const count = slashSuggestions.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setSlashIndex((index) => (Math.min(index, count - 1) + step + count) % count);
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
      const suggestion = slashSuggestions[Math.min(slashIndex, count - 1)];
      if (suggestion.disabled && e.key === 'Enter') return false;
      e.preventDefault();
      if (!suggestion.disabled) onSlashPick(suggestion);
      return true;
    }
    return false;
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (onSlashKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Sending while a turn is running is intentional, not a fall-through: the server injects the
      // text into the live turn instead of queuing it. doSend owns the shared keyboard/click guard.
      doSend();
    } else if (e.key === 'Escape') {
      // The slash menu owns Escape while it is open; otherwise Escape is the Stop shortcut the
      // composer hint has always advertised ("Running · esc to stop") but never implemented.
      if (slashOpen) { setSlashOpen(false); return; }
      if (running) { e.preventDefault(); doStop(); }
    }
  };

  return (
    <div style={{ flex: 'none' }}>
      {/* The gutter sits OUTSIDE the card's own column, so the composer sheet is wider than the
          prose it answers rather than inset from it. */}
      <div style={{ position: 'relative', padding: '6px 32px 14px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', position: 'relative' }}>
          {/* Slash palette */}
          {slashOpen ? (
            <ComposerSlashMenu
              suggestions={slashSuggestions}
              activeIndex={slashIndex}
              onHover={setSlashIndex}
              onPick={onSlashPick}
            />
          ) : null}

          {/* Task list rail. Sits directly above the input because "what the agent is doing now" is
              the highest-value line on this surface and belongs at the point of gaze; it renders
              nothing at all when the session has no task list. */}
          {!isDraft && <TodoRail sessionId={sessionId} todos={todos ?? null} />}

          {/* What the session is waiting on from OUTSIDE Cortex. Directly above the input for the same
              reason the task list is: it answers "why is nothing happening right now". Renders nothing
              when no waitpoint is armed. */}
          {!isDraft && waitpoints && (
            <WaitRail
              sessionId={sessionId}
              lang={lang}
              waitpoints={waitpoints.waitpoints}
              onCancel={waitpoints.cancel}
              cancelling={waitpoints.cancelling}
            />
          )}

          {isDraft && <DraftProjectSelector disabled={composerSend.creating} />}

          {/* Composer card. The whole chat pane is the drop zone; ChatDropOverlay carries the drag cue. */}
          <div
            className="focus-within:outline focus-within:outline-2 focus-within:outline-[var(--proto-accent-border)]"
            style={{
              position: 'relative',
              borderRadius: 'var(--r-float)',
              // CenterChat gives the composer its own grid row, outside the transcript scroller.
              // A filter-free card also lets its floating menus sample the workspace backdrop.
              background: 'var(--material-card-bg)',
              // Floating-sheet lift, plus an accent ring the moment the draft is actually sendable —
              // the ring IS the "press ⏎" affordance.
              boxShadow: composerRing
                ? 'var(--material-card-shadow), 0 0 0 1.5px var(--proto-accent-border)'
                : 'var(--material-card-shadow), 0 0 0 1px var(--proto-line)',
              transition: 'box-shadow .15s',
              padding: '12px 12px 10px 16px',
            }}
          >
            {/* Attachment chips row */}
            {hasAttachments && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  padding: '2px 2px 10px',
                  borderBottom: '1px solid var(--proto-line-2)',
                }}
              >
                {attachments.map((attachment) => (
                  <ComposerAttachmentChip
                    key={attachment.id}
                    attachment={attachment}
                    onRetry={uploads.retry}
                    onRemove={uploads.remove}
                  />
                ))}
              </div>
            )}

            {/* Text input — full card width; every control lives in the toolbar row below. */}
            <textarea
              ref={inputRef}
              data-composer-input
              rows={1}
              value={composer}
              onChange={(e) => {
                const v = e.target.value;
                setComposer(v);
                setSendError(null);
                setSlashOpen(v.startsWith('/'));
                // Height is re-fit by the useLayoutEffect on `composer`.
              }}
              onKeyDown={onKey}
              onPaste={onPaste}
              placeholder={hasAttachments ? L.wbAttachPlaceholder : L.composerPh}
              style={{
                width: '100%',
                fontSize: 13.5,
                lineHeight: 1.5,
                color: 'var(--proto-ink)',
                fontFamily: 'inherit',
                padding: hasAttachments ? '11px 2px' : '2px 0',
                border: 'none',
                outline: 'none',
                resize: 'none',
                background: 'transparent',
                maxHeight: COMPOSER_MAX_HEIGHT,
                overflowY: 'auto',
                scrollbarGutter: 'stable',
              }}
            />

            {/* Toolbar: ＋ menu left; agent, profile, context ring and Send/Stop right.
                Send is ALWAYS rendered. While a turn is running the composer still sends —
                the server injects the text into the live turn rather than queuing it behind
                that turn. Showing send as the secondary action next to Stop makes the
                keyboard behaviour (⏎ mid-turn) visible instead of accidental. */}
            <ComposerActionRow
              browser={isDraft
                ? { device: browserDevice, onChange: setBrowserDevice } satisfies ComposerBrowserControl
                // A live session shows what it was created with, without pretending it can
                // be changed now.
                : sessionBrowser
                  ? { device: sessionBrowser.device }
                  : null}
              onAttach={() => fileInputRef.current?.click()}
              onCommands={() => { composerSend.openCommands(); setSlashOpen(true); }}
              agentControl={<AgentSelectorView selection={engineSelection} />}
              selectionControl={<SessionSelectorView selection={engineSelection} />}
              contextControl={contextControl}
              sendControl={(
                <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <button
                    type="button"
                    className={MENU_FOCUS}
                    data-action="send"
                    aria-label={L.wbSend}
                    title={`${L.wbSend} · ⏎`}
                    disabled={!canSend}
                    onClick={doSend}
                    style={{
                      flex: 'none',
                      width: running ? 30 : 34,
                      height: running ? 30 : 34,
                      padding: 0,
                      borderRadius: '50%',
                      // Running: outlined/secondary so Stop stays the primary action.
                      background: running ? 'transparent' : sendBg,
                      border: running ? `1.5px solid ${canSend ? 'var(--proto-accent-border)' : 'var(--proto-line)'}` : 'none',
                      // Glow only on the filled, armed state — a disabled or outlined send
                      // button that still floated would read as the primary action it is not.
                      boxShadow: !running && canSend ? 'var(--accent-glow)' : undefined,
                      boxSizing: 'border-box',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: canSend ? 'pointer' : 'default',
                    }}
                  >
                    <svg
                      width={running ? 12 : 14}
                      height={running ? 12 : 14}
                      viewBox="0 0 14 14"
                      fill="none"
                      stroke={running ? (canSend ? 'var(--proto-accent)' : 'var(--proto-line-3)') : 'var(--ink-solid-fg)'}
                      strokeWidth="1.8"
                    >
                      <path d="M7 12V2M3 6l4-4 4 4" />
                    </svg>
                  </button>
                  {running && (
                    <button
                      type="button"
                      className={MENU_FOCUS}
                      aria-label={L.stop}
                      disabled={composerSend.stopPending}
                      data-action="stop"
                      title={`${L.stop} · esc`}
                      onClick={doStop}
                      onMouseEnter={() => setBtnHover(true)}
                      onMouseLeave={() => setBtnHover(false)}
                      style={{
                        flex: 'none',
                        width: 34,
                        height: 34,
                        border: 0, padding: 0,
                        borderRadius: '50%',
                        background: btnHover ? 'var(--ink-solid-hover)' : 'var(--proto-ink)',
                        boxShadow: 'var(--shadow-key-lift)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: composerSend.stopPending ? 'default' : 'pointer',
                      }}
                    >
                      <span style={{ width: 11, height: 11, background: 'var(--ink-solid-fg)', borderRadius: 2 }} />
                    </button>
                  )}
                </span>
              )}
            />
          </div>

          {slashErrorKey && (
            <div data-slash-error role="alert" style={{ marginTop: 7, fontSize: 12, color: 'var(--proto-danger)' }}>
              {L[slashErrorKey]}
            </div>
          )}
          {sendError && <ComposerSendFailure error={sendError} />}

          {dragOver && (
            <ChatDropOverlay
              target={dropTargetRef.current}
              fileCount={dragFileCount}
              attachedCount={attachments.length}
            />
          )}

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                addFiles(e.target.files);
                e.target.value = '';
              }
            }}
            style={{ display: 'none' }}
          />

          {/* Session meta, below the input: it is low-frequency reference information and reads as a
              footer for the composer, so the rail above the input keeps the position closest to the
              user's gaze. */}
          {showStatus && (
            <ComposerStatusLine
              running={statusLine.active}
              text={statusLine.text}
              liveText={statusLine.liveText}
              sessionText={sessionStats?.summary}
              onOpenSessionStats={sessionStats ? () => setStatsOpen(true) : undefined}
            />
          )}
          {statsOpen && sessionStats && (
            <SessionStatsModal rows={sessionStats.rows} onClose={() => setStatsOpen(false)} />
          )}
        </div>
      </div>
    </div>
  );
}
