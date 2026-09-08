// input:  Session state, chat drop target, attachments and drafts
// output: Composer with uploads, run status and slash feedback
// pos:    Workbench message input and turn-control surface
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import {
  useRef, useState, useCallback, useEffect, useLayoutEffect,
  type ReactNode, type RefObject,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang, useVocab } from '@/i18n';
import {
  buildSlashSuggestions, resolveSlashInput, runSlashAction, slashFeedbackKey,
  type SlashAction, type SlashActionHandlers, type SlashSuggestion,
} from './composer-slash';
import { formatCost } from './right-panel-vm';
import { useSelectedSession } from './SelectedSessionProvider';
import { DRAFT_SENTINEL } from './selected-session';
import {
  attachmentSendAllowed, completedAttachmentMetas, type AttachmentMeta,
} from '@/features/attachments/types';
import { useAttachmentUploads } from '@/features/attachments/useAttachmentUploads';
import {
  draftStorageKey, loadDraft, saveDraft, clearDraft, mergeRestoredDraft, type ComposerDraft,
} from './composer-draft';
import { ComposerStatusLine } from './ComposerStatusLine';
import { ComposerSendFailure } from './ComposerSendFailure';
import { ComposerAttachmentChip } from './ComposerAttachmentChip';
import { browserStartupHint, browserStartupPending } from './browser-status';
import { TodoRail } from './TodoRail';
import {
  ComposerActionRow, ComposerSlashMenu,
  type ComposerBrowserControl, type ComposerCommissionControl,
} from './ComposerActionRow';
import { commissionRequestOf, useCommissionEnabled } from './CommissionOptIn';
import { SessionProfileSelectorView, useSessionProfileSelection } from './SessionProfileSelector';
import type { ContextCompactAction } from './ContextUsageControl';
import type { TodoSnapshot } from '@cortex-agent/ui-contract';
import { runOptimisticMutation, type OptimisticUserMessage } from './optimistic-message';
import { deriveSessionRunStatus } from './session-run-status';
import { DraftProjectSelector } from './DraftProjectSelector';
import { useFileDropTarget } from './useFileDropTarget';

// Composer — a unified card: full-width input on top, one toolbar row below. The toolbar keeps the
// ＋ menu (attach · browser opt-in · local slash commands) on the left and the profile chip, context
// ring and Send/Stop cluster on the right.
// Three entry points for files: ＋ menu "attach" · paste (clipboard images) · drag & drop.
// Files upload to the server's tmp/attachments/<sessionId>/ and are referenced by path.
// Attachment chips show type badges, filenames, sizes, upload progress, and remove buttons.
// The send button enables when text is non-empty OR uploaded attachments are present.

const mono = "'IBM Plex Mono',monospace";
const DASH = '—';
// Auto-grow cap: ~15 lines at 13.5px × 1.5 line-height (≈20.25px/line), then internal scroll.
const COMPOSER_MAX_HEIGHT = 305;

export { ComposerSendFailure };

export function Composer({
  sessionId,
  running,
  backgroundRunning = false,
  turns,
  cost,
  elapsed,
  isDraft = false,
  sessionBrowser = null,
  sessionCommission = null,
  currentProfile,
  hasHistory,
  draftProfile = null,
  draftReloadToken = 0,
  projectId = 'general',
  prepareOptimistic,
  enqueueOptimistic,
  acceptOptimistic,
  rejectOptimistic,
  showStatus = true,
  statusStarting = false,
  turnProgressStarted = false,
  contextControl,
  todos,
  compactAction,
  dropTargetRef,
  onOpenSettings = () => {},
}: {
  sessionId: string;
  running: boolean;
  /** Foreground turn ended but a background task is still running (web bg-hold). `running` stays
   *  true; this only re-labels the running line "background" so the user knows the turn's own
   *  reply is done while background work continues. */
  backgroundRunning?: boolean;
  /** Real agent-turn count (snapshot + `session.turn` delta); null when unknown → rendered as —. */
  turns: number | null;
  /** Last run's total cost in USD (SessionInfo.costUsd snapshot); null while running / never-ran → —. */
  cost: number | null;
  elapsed: string;
  isDraft?: boolean;
  /** Browser control an EXISTING session was created with. Read-only — fixed at spawn. */
  sessionBrowser?: { device: string } | null;
  /** Commission mode an EXISTING session was created in. Read-only for the same reason. `label` is
   *  the commission title once one has landed; a session still drilling has no title yet. */
  sessionCommission?: { value: string; label: string | null } | null;
  currentProfile: string | null;
  hasHistory: boolean;
  draftProfile?: string | null;
  draftReloadToken?: number;
  projectId?: string;
  prepareOptimistic: (text: string, attachments?: AttachmentMeta[]) => OptimisticUserMessage;
  enqueueOptimistic: (message: OptimisticUserMessage) => void;
  acceptOptimistic: (clientId: string, settled?: { acceptedAt?: string; createdSessionId?: string }) => boolean;
  rejectOptimistic: (clientId: string, error: Error) => boolean;
  /** The untouched New Session hides status until its first optimistic message appears. */
  showStatus?: boolean;
  /** A locally queued message reads as running before the authoritative session event arrives. */
  statusStarting?: boolean;
  /** True after this turn emits its first agent progress or streamed output. */
  turnProgressStarted?: boolean;
  /** Context-usage ring (modal trigger), rendered in the toolbar right cluster beside the profile. */
  contextControl?: ReactNode;
  todos?: TodoSnapshot | null;
  compactAction?: ContextCompactAction;
  /** Optional larger surface that accepts file drops for this composer. */
  dropTargetRef?: RefObject<HTMLElement>;
  onOpenSettings?: () => void;
}): JSX.Element {
  const trpc = useTRPC();
  const L = useVocab();
  const lang = useLang();
  const queryClient = useQueryClient();
  const { selectCreatedSession, setSelectedSession } = useSelectedSession();
  const profileSelection = useSessionProfileSelection({ sessionId, currentProfile, hasHistory, isDraft });
  // Draft-only: the browser tool set is fixed when the agent process spawns, so this is a
  // creation-time choice, not a session setting.
  const [browserDevice, setBrowserDevice] = useState<string | null>(null);
  // Draft-only for the same reason as the browser, and deliberately NOT persisted into the
  // localStorage composer draft: reopening a tab must not silently re-arm commission mode.
  const [commissionChoice, setCommissionChoice] = useState<null | 'new' | string>(null);
  // Commission mode is a switchable feature (settings.commissionEnabled); when it is off the
  // composer offers no way in. A live session's read-only capsule still renders, so a session bound
  // while the feature was on keeps saying what it serves.
  const commissionEnabled = useCommissionEnabled();
  const sendMut = useMutation(trpc.sessions.send.mutationOptions());
  const cancelMut = useMutation(trpc.sessions.cancel.mutationOptions());
  const createAndSendMut = useMutation(trpc.sessions.createAndSend.mutationOptions());
  const [composer, setComposer] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [slashErrorKey, setSlashErrorKey] = useState<ReturnType<typeof slashFeedbackKey>>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const localDropTargetRef = useRef<HTMLDivElement>(null);
  // Resolve a restored draft bucket before the shared controller binds. This keeps a scope change
  // from briefly binding a random bucket and then clearing the restored metadata on the next render.
  const draftKey = draftStorageKey({ isDraft, sessionId, projectId });
  const draftIdentity = `${draftKey ?? ''}:${isDraft ? draftReloadToken : 0}`;
  useEffect(() => { setSlashErrorKey(null); }, [composer, draftIdentity]);
  const draftUploadId = useRef<string | null>(null);
  const uploadIdentityRef = useRef<string | null>(null);
  if (uploadIdentityRef.current !== draftIdentity) {
    uploadIdentityRef.current = draftIdentity;
    draftUploadId.current = isDraft ? (loadDraft(draftKey)?.draftUploadId ?? crypto.randomUUID()) : null;
  }
  const uploadSessionId = isDraft ? (draftUploadId.current ?? '') : sessionId;

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

  // ── Slash palette state ──
  const [slashOpen, setSlashOpen] = useState(false);

  // ── Hover states ──
  const [btnHover, setBtnHover] = useState(false);

  // ── Attachment state ──
  const attachmentUploads = useAttachmentUploads({ scope: draftIdentity, bucket: uploadSessionId });
  const attachments = attachmentUploads.items;
  const composerRef = useRef(composer);
  const attachmentsRef = useRef(attachments);
  composerRef.current = composer;
  attachmentsRef.current = attachments;
  // Re-fit the textarea whenever the chip row appears/disappears: its vertical padding changes with
  // attachments (2px→11px). Pasting an image mutates `attachments` but not `composer`, so the
  // `[composer]` effect above never re-fires and the box stayed fitted to the old padding — the text
  // was clipped. Keyed on the boolean edge so it runs once per toggle, not on every chip mutation.
  const hasAttachmentsForFit = attachments.length > 0;
  useLayoutEffect(() => {
    autoGrow(inputRef.current);
  }, [hasAttachmentsForFit]);

  // ── Per-session draft persistence (localStorage) ──
  // The composer text + successfully-uploaded attachments are persisted per scope so a draft survives
  // an app restart (stable webview/browser origin) and a server restart (the referenced upload files
  // live on the server and are not wiped on boot). One effect both LOADS on scope change and SAVES on
  // content change, distinguished by comparing the live key to a ref — so switching sessions swaps the
  // draft cleanly and never writes the outgoing content under the incoming key.
  const currentDraftIdentityRef = useRef(draftIdentity);
  currentDraftIdentityRef.current = draftIdentity;
  const draftKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (draftKeyRef.current !== draftIdentity) {
      // Scope or external prefill changed → load the draft; skip saving on this cycle.
      draftKeyRef.current = draftIdentity;
      if (!draftKey) return; // no stable scope (transient empty sessionId) → leave content untouched
      const d = loadDraft(draftKey);
      if (isDraft && d?.draftUploadId) draftUploadId.current = d.draftUploadId;
      setComposer(d?.text ?? '');
      attachmentUploads.replaceRestored(d?.attachments ?? []);
      return;
    }
    // Same scope, content changed → persist.
    saveDraft(draftKey, {
      text: composer,
      attachments: attachments.filter((a) => a.status === 'done' && a.meta).map((a) => a.meta!),
      ...(isDraft && draftUploadId.current ? { draftUploadId: draftUploadId.current } : {}),
    });
  }, [draftKey, draftIdentity, composer, attachments, isDraft, attachmentUploads.replaceRestored]);

  const addFiles = attachmentUploads.addFiles;
  const removeAttachment = attachmentUploads.remove;
  const retryAttachment = attachmentUploads.retry;
  const activeDropTargetRef = dropTargetRef ?? localDropTargetRef;
  const { active: dragOver, fileCount: dragFileCount } = useFileDropTarget(activeDropTargetRef, addFiles);

  const hasAttachments = attachments.length > 0;
  const doneAttachments = attachmentUploads.completed;
  const hasPendingUploads = attachmentUploads.hasNonDone;
  const canSend = attachmentSendAllowed(composer, attachments) && (!!sessionId || isDraft)
    && !sendMut.isPending && !createAndSendMut.isPending;
  const composerBorder = slashOpen ? 'var(--proto-accent)' : dragOver ? 'var(--proto-accent)' : 'var(--proto-line-3)';
  const sendBg = canSend ? 'var(--proto-ink)' : 'var(--proto-line-3)';
  // Real agent-turn count; render — when unknown (no run yet / running turn before first progress).
  const turnsText = turns == null ? DASH : `${turns} ${L.wbTurnsUnit}`;
  // Last run's cost; render — when unknown (running turn not yet finalized / never ran).
  const costText = cost == null ? DASH : formatCost(cost);
  // A session has run at least one turn once it carries a turn count. A fresh/never-run session (draft
  // or created-but-unused) shows just `idle` — no placeholder metrics until a turn produces real values.
  const hasRun = !isDraft && turns != null;
  const runStatus = deriveSessionRunStatus({
    running: running || statusStarting, backgroundRunning, hasRun,
  });
  const runStatusLabel = runStatus.phase === 'background' ? L.pillBackground
    : runStatus.phase === 'foreground' ? L.pillRunning
      : L.wbIdle;
  const statusMetrics = [runStatusLabel, elapsed, turnsText, ...(runStatus.showCost ? [costText] : [])];
  const runStatusText = runStatus.showMetrics ? statusMetrics.join(' · ') : runStatusLabel;
  const statusBrowserDevice = sessionBrowser?.device ?? browserDevice;
  const browserStarting = browserStartupPending({
    running: runStatus.active,
    backgroundRunning,
    device: statusBrowserDevice,
    turnProgressStarted,
  });

  const slashProfiles = profileSelection.options.map((option) => ({
    name: option.name, detail: option.sub, disabled: option.disabled,
  }));
  const slashAvailability = {
    newDisabled: hasPendingUploads,
    cancelDisabled: !running || cancelMut.isPending,
    compactDisabled: !compactAction || compactAction.disabled || compactAction.pending,
    settingsDisabled: hasPendingUploads,
  };
  const slashList = buildSlashSuggestions(composer, slashProfiles, slashAvailability);

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

  // ── Send ──
  const restoreRejectedSend = (
    sent: ComposerDraft,
    sentKey: string | null,
    sentIdentity: string,
    error: Error,
  ): void => {
    const stillCurrent = currentDraftIdentityRef.current === sentIdentity;
    const current = stillCurrent
      ? {
          text: composerRef.current,
          attachments: completedAttachmentMetas(attachmentsRef.current),
          ...(draftUploadId.current ? { draftUploadId: draftUploadId.current } : {}),
        }
      : (loadDraft(sentKey) ?? { text: '', attachments: [] });
    const restored = mergeRestoredDraft(current, sent);
    saveDraft(sentKey, restored);
    if (!stillCurrent) return;
    if (restored.draftUploadId) draftUploadId.current = restored.draftUploadId;
    setComposer(restored.text);
    attachmentUploads.mergeRestored(sent.attachments);
    setSendError(error.message);
  };

  const clearConsumedComposer = (): void => {
    clearDraft(draftKey);
    setComposer('');
    attachmentUploads.reset();
    setSlashOpen(false);
    if (inputRef.current) inputRef.current.style.height = 'auto';
  };

  const doSendText = (raw: string): void => {
    const text = raw.trim();
    const metas = doneAttachments;
    if (!text && metas.length === 0) return;
    if (!isDraft && !sessionId) return;
    const sent: ComposerDraft = {
      text, attachments: metas,
      ...(isDraft && draftUploadId.current ? { draftUploadId: draftUploadId.current } : {}),
    };
    const message = prepareOptimistic(text, metas);
    const sentKey = draftKey;
    const sentIdentity = draftIdentity;
    setSendError(null);
    const mutation = runOptimisticMutation<
      { sessionId: string; acceptedAt: string } | { accepted: boolean; acceptedAt: string }
    >({
      message,
      mutate: () => isDraft
        ? createAndSendMut.mutateAsync({
            projectId, profileName: draftProfile ?? undefined, text,
            ...(browserDevice ? { browser: { device: browserDevice } } : {}),
            ...(commissionEnabled && commissionRequestOf(commissionChoice)
              ? { commission: commissionRequestOf(commissionChoice) } : {}),
            draftUploadId: sent.draftUploadId,
            ...(metas.length > 0 ? { attachments: metas } : {}),
          } as any)
        : sendMut.mutateAsync({ sessionId, text, ...(metas.length > 0 ? { attachments: metas } : {}) } as any),
      onEnqueue: enqueueOptimistic,
      onAccepted: (entry, data) => {
        if ('sessionId' in data) {
          const selectCreated = acceptOptimistic(entry.clientId, {
            acceptedAt: data.acceptedAt, createdSessionId: data.sessionId,
          });
          queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
          if (selectCreated) {
            draftUploadId.current = null;
            selectCreatedSession(data.sessionId);
          }
        } else {
          acceptOptimistic(entry.clientId, { acceptedAt: data.acceptedAt });
        }
      },
      onRejected: (entry, error) => rejectOptimistic(entry.clientId, error),
    });
    clearConsumedComposer();
    void mutation.then((result) => {
      if (!result.ok && result.restore) restoreRejectedSend(sent, sentKey, sentIdentity, result.error);
    });
  };

  const doStop = (): void => {
    if (!sessionId || cancelMut.isPending) return;
    cancelMut.mutate({ sessionId });
  };

  const slashHandlers: SlashActionHandlers = {
    onNew: () => setSelectedSession(DRAFT_SENTINEL),
    onCancel: () => { if (running) doStop(); },
    onCompact: () => compactAction?.onCompact(),
    onProfile: profileSelection.pick,
    onSettings: onOpenSettings,
  };

  const consumeSlashText = (): void => {
    saveDraft(draftKey, {
      text: '',
      attachments: doneAttachments,
      ...(isDraft && draftUploadId.current ? { draftUploadId: draftUploadId.current } : {}),
    });
    setComposer('');
    setSlashOpen(false);
  };

  const executeSlashAction = (action: SlashAction): void => {
    consumeSlashText();
    runSlashAction(action, slashHandlers);
  };

  const handleSlashInput = (text: string): boolean => {
    const resolution = resolveSlashInput(text, slashProfiles, slashAvailability);
    if (resolution.kind === 'none') return false;
    if (resolution.kind === 'action') executeSlashAction(resolution.action);
    setSlashErrorKey(slashFeedbackKey(resolution));
    return true;
  };

  const onSlashPick = (suggestion: SlashSuggestion): void => {
    if (suggestion.disabled) return;
    if (suggestion.action) executeSlashAction(suggestion.action);
    else { setComposer(`${suggestion.command} `); setSlashOpen(true); }
  };

  const doSend = (): void => {
    if (handleSlashInput(composer)) return;
    if (!canSend) return;
    doSendText(composer);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
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
      <div
        ref={localDropTargetRef}
        style={{ maxWidth: 756, margin: '0 auto', padding: '0 32px 18px', position: 'relative' }}
      >
        {/* Slash palette */}
        {slashOpen ? <ComposerSlashMenu suggestions={slashList} onPick={onSlashPick} /> : null}

        {/* Task list rail. Sits directly above the input because "what the agent is doing now" is
            the highest-value line on this surface and belongs at the point of gaze; it renders
            nothing at all when the session has no task list. */}
        {!isDraft && <TodoRail sessionId={sessionId} todos={todos ?? null} lang={lang} />}

        {isDraft && <DraftProjectSelector disabled={createAndSendMut.isPending} />}

        {/* Composer card — doubles as drop zone (15a) */}
        <div
          style={{
            position: 'relative',
            border: dragOver ? '1.5px dashed var(--proto-accent)' : '1.5px solid ' + composerBorder,
            borderRadius: 12,
            background: dragOver ? 'var(--proto-rail)' : 'var(--proto-card)',
            boxShadow: dragOver ? 'none' : 'var(--shadow-card-soft)',
            padding: '10px 12px 10px 14px',
          }}
        >
          {/* Drop state — empty composer: replace content with centered drop prompt */}
          {dragOver && !hasAttachments ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
                padding: '22px 12px',
              }}
            >
              <span style={{ font: `600 11.5px ${mono}`, color: 'var(--proto-accent)' }}>
                {dragFileCount > 0
                  ? L.wbDropFilesPlural.replace('{n}', String(dragFileCount))
                  : L.wbDropFilesSingular}
              </span>
              <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-muted-3)' }}>
                {L.wbAttachPath}
              </span>
            </div>
          ) : (
            <>
              {/* Drop state with existing attachments: dim content + overlay */}
              <div
                style={{
                  opacity: dragOver ? 0.4 : 1,
                  pointerEvents: dragOver ? 'none' : 'auto',
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
                        onRetry={retryAttachment}
                        onRemove={removeAttachment}
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
                  }}
                />

                {/* Toolbar: ＋ menu left; profile, context ring and Send/Stop right.
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
                  commission={isDraft
                    ? commissionEnabled
                      ? { value: commissionChoice, onChange: setCommissionChoice } satisfies ComposerCommissionControl
                      : null
                    : sessionCommission
                      ? { value: sessionCommission.value, label: sessionCommission.label }
                      : null}
                  onAttach={() => fileInputRef.current?.click()}
                  onCommands={() => { setComposer('/'); setSlashOpen(true); }}
                  profileControl={<SessionProfileSelectorView selection={profileSelection} />}
                  contextControl={contextControl}
                  sendControl={(
                    <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <button
                        type="button"
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
                        <div
                          data-action="stop"
                          title={`${L.stop} · esc`}
                          onClick={doStop}
                          onMouseEnter={() => setBtnHover(true)}
                          onMouseLeave={() => setBtnHover(false)}
                          style={{
                            flex: 'none',
                            width: 34,
                            height: 34,
                            borderRadius: '50%',
                            background: btnHover ? 'var(--ink-solid-hover)' : 'var(--proto-ink)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: cancelMut.isPending ? 'default' : 'pointer',
                          }}
                        >
                          <span style={{ width: 11, height: 11, background: 'var(--proto-card)', borderRadius: 2 }} />
                        </div>
                      )}
                    </span>
                  )}
                />
              </div>

              {/* Floating overlay when dragging with existing attachments */}
              {dragOver && hasAttachments && (
                <div
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    transform: 'translate(-50%,-50%)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 3,
                    background: 'var(--panel-translucent-bg)',
                    border: '1px solid var(--proto-accent-border)',
                    borderRadius: 10,
                    padding: '10px 18px',
                    boxShadow: 'var(--shadow-accent-soft)',
                    zIndex: 2,
                  }}
                >
                  <span style={{ font: `600 11.5px ${mono}`, color: 'var(--proto-accent)' }}>
                    {dragFileCount > 0
                      ? L.wbDropAddMoreN.replace('{n}', String(dragFileCount))
                      : L.wbDropAddMore}
                  </span>
                  <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-muted-3)' }}>
                    {L.wbDragOverCount.replace('{n}', String(attachments.length)).replace('{m}', String(attachments.length + dragFileCount))}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        {slashErrorKey && (
          <div data-slash-error role="alert" style={{ marginTop: 7, fontSize: 12, color: 'var(--proto-danger)' }}>
            {L[slashErrorKey]}
          </div>
        )}
        {sendError && <ComposerSendFailure error={sendError} />}

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
            running={runStatus.active}
            text={browserStarting && statusBrowserDevice
              ? browserStartupHint(statusBrowserDevice, L.wbBrowserStarting)
              : runStatusText}
          />
        )}
      </div>
    </div>
  );
}
