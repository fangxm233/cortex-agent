import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { ChatMarkdown } from '@/design/ChatMarkdown';
import { ContextUsageRing } from '@/features/session/composer/ContextUsageControl';
import { TranscriptLoadError } from '@/features/session/transcript/TranscriptLoadError';
import { useRevealedText } from '@/features/session/transcript/useRevealedText';
import { useTranscriptWindow } from '@/features/session/transcript/useTranscriptWindow';
import { useStickToBottom } from '@/features/session/transcript/useStickToBottom';
import { ChatNotice } from '@/features/session/transcript/ChatNotice';
import { SubagentTranscriptDetail } from '@/features/session/transcript/SubagentTranscriptDetail';
import { SubagentBlock } from '@/features/session/transcript/SubagentBlock';
import { ToolCallsRow } from '@/features/session/transcript/ToolCallsRow';
import { DecisionCardGroup } from '@/features/session/interaction/DecisionCards';
import { fmt, useVocab, useVocabOptional } from '@/i18n';
import { assistantTurnCopyTargets, regenNoteIndexes, systemOriginBody, systemOriginDisplay, systemOriginLabel, systemOriginSummary, type ChatRow } from '@/features/session/transcript/transcript-vm';
import { interactionView, emptyAskAnswers } from '@/features/session/interaction/interaction-vm';
import { MComposer, MC, MONO } from '@/mobile/ui/kit';
import { MAskCard, MPlanCard } from './MInteractionCards';
import { AttachmentGroup } from './MChatAttachments';
import { AssistantTurnCopyAction, longPressHandlers, MsgActionMenu } from './MChatMessageActions';
import {
  ComposerAbove, ComposerKeys, ComposerTools, MobileSlashMenu, useFilePicker,
} from './MChatComposerPresentation';
import { MChatOverlays } from './MChatOverlays';
import { selectionView, type MChatSelectionView } from './m-chat-selection';
import { useChatOverlay, type ChatOverlay } from './useChatOverlay';
import type { ChatHeaderStatus } from './m-chat-vm';
import { useComposerClearance } from './useComposerClearance';
import { HEADER_BOTTOM_VAR, useHeaderClearance } from './useHeaderClearance';
import { useNowTick } from '@/lib/useNowTick';
import { hasActiveWorker, MTeamRow } from './MChatTeam';
import { BoardStatusBar } from '@/features/board/BoardStatusBar';
import { LeadWaitingLine, TeamActionRow, TeamStreamProvider, TeamUpdateCard } from '@/features/team/TeamStreamRows';
import type { MChatInteractions, MChatViewProps, MEditMode } from './MChatView.types';

export type { MChatInteractions, MEditMode, MMsgMenu, MRejectBar } from './MChatView.types';

// ── floating header — back chevron · title + status line · context ring · ⋯ ───
interface MChatHeaderProps {
  title: string;
  /** Team mode: the worker's lead, a tappable prefix before the title. */
  parent?: { title: string; onSelect: () => void } | null;
  status: ChatHeaderStatus;
  /** Project the session belongs to; prefixes the status line when known. */
  project?: string;
  onBack: () => void;
  onMore: () => void;
  /** Context usage, as a round key left of ⋯. Absent on a session that reports no window. */
  contextControl?: ReactNode;
}

/** The header pill and, in team mode, the team summary row under it: one floating stack, measured once
 *  (useHeaderClearance). */
const HEADER_STACK: CSSProperties = {
  position: 'absolute', top: 'calc(8px + env(safe-area-inset-top))', left: 12, right: 12, zIndex: 5,
  display: 'flex', flexDirection: 'column', gap: 6,
};

const CHAT_HEADER: CSSProperties = {
  position: 'relative', height: 52, flex: 'none',
  display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px 0 4px',
  borderRadius: 'var(--r-float)', background: MC.glass,
  backdropFilter: MC.glassFilter, WebkitBackdropFilter: MC.glassFilter,
  boxShadow: '0 0 0 1px var(--proto-line), var(--shadow-chrome-float)',
  boxSizing: 'border-box',
};

const HEADER_KEY: CSSProperties = {
  flex: 'none', width: 44, height: 44, border: 0, background: 'transparent', padding: 0,
  cursor: 'pointer',
};

function BackChevron(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m15 6-6 6 6 6" />
    </svg>
  );
}

/** The header floats over the transcript rather than docking above it, so it is built here instead
 *  of through `MDrillHeader`: that kit header is a bordered flex band the other drill screens still
 *  want. */
export function MChatHeader(props: MChatHeaderProps): JSX.Element {
  const vocab = useVocabOptional();
  return (
    <div data-chat-header="true" style={CHAT_HEADER}>
      <button type="button" aria-label={vocab.back} onClick={props.onBack}
        style={{ ...HEADER_KEY, color: 'var(--proto-accent)', display: 'grid', placeItems: 'center' }}>
        <BackChevron />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none', background: props.status.tone === 'waiting' ? 'var(--proto-amber)' : props.status.running ? 'var(--proto-accent)' : 'var(--proto-line-3)' }} />
          {props.parent && (
            <button type="button" data-lead-crumb="" aria-label={`${vocab.wbTeamOpenLead} · ${props.parent.title}`}
              onClick={props.parent.onSelect}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, maxWidth: '45%', flexShrink: 1,
                padding: 0, border: 0, background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, color: MC.muted }}>
              <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{props.parent.title}</span>
              <span aria-hidden="true" style={{ flex: 'none' }}>/</span>
            </button>
          )}
          <span style={{ minWidth: 0, fontSize: 14, fontWeight: 600, color: MC.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {props.title}
          </span>
        </div>
        <MChatStatusLine {...props} />
      </div>
      {props.contextControl}
      <button type="button" aria-label={vocab.more} onClick={props.onMore}
        style={{ ...HEADER_KEY, color: 'var(--proto-muted-2)', fontSize: 18, letterSpacing: '1px' }}>
        ⋯
      </button>
    </div>
  );
}

/** Context usage is a bare ring here, not a bordered key: the header pill is already a framed
 *  surface, so a second frame inside it reads as a control on a control. The ring is itself the
 *  button — nesting one inside a round wrapper would nest a button in a button. */
const HEADER_CONTEXT_KEY: CSSProperties = {
  width: 44, height: 44, borderRadius: '50%', background: 'transparent', border: 0, flexShrink: 0,
  boxSizing: 'border-box', justifyContent: 'center',
};

/** Flat muted ink: the waiting tone the line used to carry in amber now rides the title-row dot. */
function MChatStatusLine({ status, project }: MChatHeaderProps): JSX.Element {
  const now = useNowTick(!!status.liveText);
  const text = status.liveText ? status.liveText(now) : status.text;
  return (
    <div data-chat-status-line="true" style={{ font: `400 11px ${MONO}`, color: MC.muted, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      {project ? `${project} · ${text}` : text}
    </div>
  );
}

// The ⋯ menu exposes the Session ID sheet plus, once the session has run, its whole-session stats.
/**
 * One native subagent's work, folded away by default.
 *
 * Mobile renders a FLAT view — tool runs and prose, no nesting — but in TRANSCRIPT ORDER: each
 * `tools` row keeps its own collapsed run, sitting between the prose blocks it ran between, exactly
 * as the desktop block shows it. Merging every call into one run at the top (what this did before)
 * made a long subagent read as a single tool row followed by orphaned notes, because the reader
 * could no longer tell which calls belonged to which step. Rows the mobile block has no form for
 * (nested subagents, notices, interactions) are still skipped.
 */
function MSubagentRows({ rows, sessionId }: { rows: ChatRow[]; sessionId?: string }): JSX.Element {
  return <>{rows.map((row, index) => {
    if (row.kind === 'tools' && row.count > 0) {
      return <MToolCallsRow key={index} row={row} sessionId={sessionId} />;
    }
    if (row.kind === 'assistant' && row.text) {
      return <div key={index} style={{ fontSize: 12.5, lineHeight: 1.6,
        color: MC.body, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
        <ChatMarkdown text={row.text} />
      </div>;
    }
    return null;
  })}</>;
}

function MSubagentDetail({ row, sessionId }: {
  row: Extract<ChatRow, { kind: 'subagent' }>; sessionId?: string;
}): JSX.Element {
  if (row.detailMode !== 'lazy' || !row.hasDetails || !sessionId) {
    return <MSubagentRows rows={row.children} sessionId={sessionId} />;
  }
  return <SubagentTranscriptDetail sessionId={sessionId} subagentId={row.id}
    fallbackRows={row.children}
    render={(rows) => <MSubagentRows rows={rows} sessionId={sessionId} />} />;
}

/** The desktop subagent card in its touch form; only the body renderer stays mobile-specific. */
function MSubagentBlock({ row, sessionId }: {
  row: Extract<ChatRow, { kind: 'subagent' }>;
  sessionId?: string;
}): JSX.Element {
  return (
    <SubagentBlock agentType={row.agentType} description={row.description} prompt={row.prompt}
      model={row.model} status={row.status} toolCount={row.toolCount} touch>
      <MSubagentDetail row={row} sessionId={sessionId} />
    </SubagentBlock>
  );
}

/** The desktop tool group in its touch form. */
function MToolCallsRow({ row, sessionId }: {
  row: Extract<ChatRow, { kind: 'tools' }>;
  sessionId?: string;
}): JSX.Element {
  const calls = row.calls.map((call) => ({
    kind: call.kind, input: call.input,
    ...(call.images ? { images: call.images } : {}),
    ...(call.debug ? { debug: call.debug } : {}),
  }));
  return <ToolCallsRow calls={calls} sessionId={sessionId} touch />;
}

// ── the message stream (reuses ChatMarkdown; renders attachments above/below bubbles) ──

const NOOP = (): void => {};
const NO_WORKERS: SessionInfo[] = [];

/**
 * One assistant block. `preview` marks the block being written RIGHT NOW (the token-level
 * accumulation) — the only row the smooth reveal paces, using the same rule and the same frame loop
 * as the desktop chat (`features/session/transcript/reveal-pacing` + `useRevealedText`). `streaming` cannot
 * express this: the idle heuristic also flags the last COMPLETE row for a couple of seconds after
 * the turn's final event, and pacing a settled message would re-type text already read.
 *
 * Paced and committed text render through this SAME component instance (the preview row and the
 * message that supersedes it occupy the same position in the stream), so when the authoritative text
 * lands the row simply stops being a preview and is drawn whole on that render — it settles without
 * a remount. No caret either way: the blinking output-position block was removed by request.
 *
 * `dropTrailingHr` — assistant messages often end with a `---` separator; on mobile that dangling
 * horizontal rule reads as cruft, so it is stripped.
 */
function MAssistantBlock({ text, preview, streamKey }: {
  text: string;
  preview?: boolean;
  streamKey?: string;
}): JSX.Element | null {
  const shown = useRevealedText(text, !!preview, streamKey);
  if (!shown.trim()) return null;
  return <ChatMarkdown text={shown} dropTrailingHr renderMath />;
}

/** Interaction row for the mobile stream (scheme 6a/5b/4a-c). Entity rows render the full cards
 *  — pending actionable, resolved sealed in place; expired/cancelled + legacy rows render a
 *  one-line summary. Without handlers the cards render inert. */
function MInteractionRow({ row, interactions }: { row: Extract<ChatRow, { kind: 'interaction' }>; interactions?: MChatInteractions }): JSX.Element {
  const copy = useVocabOptional();
  const v = interactionView(row, copy);
  if (v.kind === 'ask') {
    const m = v.model;
    return (
      <MAskCard
        model={m}
        state={interactions?.askState(m.requestId) ?? emptyAskAnswers}
        copy={copy}
        onPick={(label) => interactions?.onAskPick(m, label)}
        onToggle={(label) => interactions?.onAskToggle(m, label)}
        onConfirmMulti={() => interactions?.onAskConfirmMulti(m)}
      />
    );
  }
  if (v.kind === 'plan') {
    const m = v.model;
    return (
      <MPlanCard
        model={m}
        copy={copy}
        dimmed={interactions?.rejectingId === m.requestId}
        onApprove={interactions ? () => interactions.onApprove(m) : NOOP}
        onRejectStart={interactions ? () => interactions.onRejectStart(m) : NOOP}
        onOpenRead={interactions ? () => interactions.onOpenRead(m) : NOOP}
      />
    );
  }
  const color = v.tone === 'rejected' ? 'var(--proto-danger)' : v.tone === 'inactive' ? MC.muted : MC.done;
  const icon = v.tone === 'rejected' ? '✗' : v.tone === 'inactive' ? '◌' : '✓';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px', background: 'var(--material-inset-bg)', border: '1px solid var(--proto-line-2)', borderRadius: 'var(--r-control)' }}>
      <span style={{ fontSize: 11, fontWeight: 700, color, flexShrink: 0 }}>{icon} {v.label}</span>
      <span style={{ fontSize: 11.5, color: MC.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.text}</span>
    </div>
  );
}

/**
 * A turn Cortex wrote rather than the human — resume signal, task/thread callback, subtask
 * question, backgrounded agent result. Same rule as the desktop stream: state what produced it and
 * one clipped line of what it said, never a user bubble. No long-press menu either: there is no
 * human message here to copy or rewind to. The full text stays in the transcript record; mobile
 * has no DEBUG inspector, so the desktop chat is where it is read.
 */
function MSystemHintRow({ row }: { row: Extract<ChatRow, { kind: 'user' }> }): JSX.Element {
  const L = useVocab();
  const [open, setOpen] = useState(false);
  const summary = systemOriginSummary(row.text);
  // A worker's report or request opens to its full text (systemOriginDisplay); other hints stay one line.
  const body = systemOriginDisplay(row.systemOrigin!) === 'expandable' ? systemOriginBody(row.text) : '';
  const canOpen = body.length > 0;
  const line = (
    <div
      data-system-origin={row.systemOrigin}
      role={canOpen ? 'button' : undefined}
      aria-expanded={canOpen ? open : undefined}
      aria-label={canOpen ? (open ? L.wbTeamHideFull : L.wbTeamShowFull) : undefined}
      onClick={canOpen ? () => setOpen((v) => !v) : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 7, padding: '2px 0',
        opacity: row.pending ? 0.55 : 1,
        cursor: canOpen ? 'pointer' : undefined,
      }}
    >
      <span aria-hidden="true" style={{ width: 3, alignSelf: 'stretch', minHeight: 13, borderRadius: 2, background: MC.divider, flexShrink: 0 }} />
      <span style={{ font: `600 11px ${MONO}`, letterSpacing: '.04em', color: MC.muted, flexShrink: 0 }}>
        {systemOriginLabel(row.systemOrigin!, L)}
      </span>
      {summary && !open && (
        <span style={{ fontSize: 11, color: MC.muted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </span>
      )}
      {canOpen && (
        <span aria-hidden="true" style={{ font: `400 11px ${MONO}`, color: MC.muted, flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none' }}>›</span>
      )}
    </div>
  );
  if (!canOpen || !open) return line;
  return (
    <div>
      {line}
      <div data-system-origin-body="" style={{ margin: '4px 0 2px 10px', padding: '2px 0 2px 10px', borderLeft: `1px solid ${MC.divider}`,
        fontSize: 13, lineHeight: 1.6, color: MC.body, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
        <ChatMarkdown text={body} dropTrailingHr />
      </div>
    </div>
  );
}

const DIM: CSSProperties = { opacity: 0.35, pointerEvents: 'none' };

/** How long a tap inside the stream holds auto-scroll, so what it expanded stays in view. */
const TAP_FREEZE_MS = 800;

interface StreamContext {
  interactions?: MChatInteractions;
  streamKey?: string;
  editing?: MEditMode | null;
  /** Long-press handlers for a row that can be held right now; null otherwise. */
  holdFor: (row: ChatRow, index: number) => ReturnType<typeof longPressHandlers> | null;
  /** The sec-7 edit affordances are on (编辑中 / 将被回退 / 已编辑 / regen note). */
  editable: boolean;
  /** Rows that open with the 由编辑重新生成 note. */
  regen: Set<number> | null;
  onShowOriginal?: (edited: { originalText: string; originalTs: string }) => void;
}

interface RowProps<K extends ChatRow['kind']> {
  row: Extract<ChatRow, { kind: K }>;
  index: number;
  /** 7b edit mode: rows after the held one dim under the 将被回退 badge. */
  dimmed: boolean;
  /** The turn's whole answer when this row closes it; the copy action rides the last row. */
  copyText?: string;
  ctx: StreamContext;
}

function DividerRow({ row, dimmed }: RowProps<'divider'>): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, ...(dimmed ? { opacity: 0.35 } : {}) }}>
      <div style={{ flex: 1, height: 1, background: 'var(--proto-line)' }} />
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', color: MC.muted }}>{row.text}</div>
      <div style={{ flex: 1, height: 1, background: 'var(--proto-line)' }} />
    </div>
  );
}

function userBubbleStyle(pending: boolean | undefined, held: boolean, editingRow: boolean): CSSProperties {
  return {
    background: 'var(--material-card-bg)',
    border: '1px solid var(--proto-line)',
    // A message written into the running turn's backend that the model has not read yet dims its
    // TEXT and nothing else — same bubble, full opacity, no icon, badge or spinner. The row is
    // provisional, not disabled or failing, and any marker heavier than the ink would read as one.
    // It clears the instant it is delivered.
    color: pending ? MC.muted : MC.ink,
    borderRadius: '18px 18px 6px 18px',
    padding: '10px 14px',
    fontSize: 15,
    lineHeight: 1.5,
    boxShadow: 'var(--material-card-shadow)',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    wordBreak: 'break-word',
    WebkitUserSelect: held ? 'none' : undefined,
    userSelect: held ? 'none' : undefined,
    WebkitTouchCallout: held ? 'none' : undefined,
    ...(editingRow ? { boxShadow: `var(--material-card-shadow), 0 0 0 1.5px ${MC.run}` } : {}),
  } as CSSProperties;
}

/** 7b — the 将被回退 badge opens the dimmed tail right after the edited bubble. */
function WillRewindBadge({ editing }: { editing: MEditMode }): JSX.Element {
  const L = useVocabOptional();
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <span style={{ font: `600 11px ${MONO}`, color: 'var(--m-amber-ink)', background: MC.amberBg, padding: '2px 7px', borderRadius: 4 }}>
        {fmt(L.chatWillRewind, {
          replies: fmt(editing.replies === 1 ? L.msgReplyOne : L.msgReplyMany, { n: editing.replies }),
          tools: fmt(editing.toolCalls === 1 ? L.msgToolCallOne : L.msgToolCallMany, { n: editing.toolCalls }),
        })}
      </span>
    </div>
  );
}

/** 已编辑 note — tap opens the original-message sheet. */
function EditedNote({ onTap }: { onTap?: () => void }): JSX.Element {
  return (
    <span role="button" onClick={onTap} style={{ font: `400 11px ${MONO}`, color: MC.muted, cursor: 'pointer' }}>
      <span style={{ borderBottom: `1px dotted ${MC.muted}` }}>{useVocabOptional().msgEdited}</span>
    </span>
  );
}

function UserBubbleRow({ row, index, dimmed, ctx }: RowProps<'user'>): JSX.Element {
  const L = useVocabOptional();
  const editingRow = ctx.editing?.rowIndex === index;
  const hold = ctx.holdFor(row, index);
  const edited = ctx.editable && row.edited && !editingRow ? row.edited : null;
  return (
    <>
      {row.attachments && row.attachments.length > 0 && <AttachmentGroup attachments={row.attachments} />}
      <div style={{ alignSelf: 'flex-end', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, maxWidth: '84%', ...(dimmed ? DIM : {}) }}>
        {/* 7b — the bubble being edited rings accent + 编辑中 badge */}
        {editingRow && (
          <span style={{ font: `600 11px ${MONO}`, color: MC.run, background: 'var(--proto-accent-bg)', padding: '2px 7px', borderRadius: 4 }}>{L.chatEditingBadge}</span>
        )}
        {row.systemOrigin && (
          <span data-bubble-label="" style={{ font: `600 11px ${MONO}`, letterSpacing: '.04em', color: MC.muted }}>{systemOriginLabel(row.systemOrigin, L)}</span>
        )}
        <div {...(hold ?? {})} data-msg-bubble={hold ? index : undefined} style={userBubbleStyle(row.pending, !!hold, editingRow)}>
          {row.text}
        </div>
        {edited && <EditedNote onTap={ctx.onShowOriginal ? () => ctx.onShowOriginal!(edited) : undefined} />}
      </div>
      {editingRow && ctx.editing && <WillRewindBadge editing={ctx.editing} />}
    </>
  );
}

function UserRow(props: RowProps<'user'>): JSX.Element {
  const { row, dimmed, copyText } = props;
  if (!row.systemOrigin || systemOriginDisplay(row.systemOrigin) === 'bubble') return <UserBubbleRow {...props} />;
  return (
    <div style={dimmed ? DIM : undefined}>
      <MSystemHintRow row={row} />
      {/* The hint line is the machine steering itself INSIDE the turn, so it can be the turn's last
          row while the reply is still running — the copy action rides it so it stays at the bottom
          of the answer instead of above the hints. */}
      <AssistantTurnCopyAction text={copyText} />
    </div>
  );
}

function AssistantRow({ row, index, dimmed, copyText, ctx }: RowProps<'assistant'>): JSX.Element {
  const L = useVocabOptional();
  return (
    <div style={{ fontSize: 15, lineHeight: 1.6, color: MC.body, minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word', ...(dimmed ? DIM : {}) }}>
      {/* 由编辑重新生成 — footnote atop the first regenerated reply after an edit */}
      {ctx.regen?.has(index) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, font: `400 11px ${MONO}`, color: MC.muted, marginBottom: 4 }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--proto-line-3)', flex: 'none' }} />
          {L.msgRegenNote}
        </div>
      )}
      <MAssistantBlock text={row.text} preview={row.preview} streamKey={ctx.streamKey} />
      {row.attachments && row.attachments.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <AttachmentGroup attachments={row.attachments} side="left" />
        </div>
      )}
      {row.decisions && row.decisions.length > 0 && (
        <DecisionCardGroup decisions={row.decisions} sessionId={ctx.streamKey} touch />
      )}
      <AssistantTurnCopyAction text={copyText} />
    </div>
  );
}

function Dimmable({ dimmed, copyText, children }: { dimmed: boolean; copyText?: string; children: ReactNode }): JSX.Element {
  return <div style={dimmed ? DIM : undefined}>{children}<AssistantTurnCopyAction text={copyText} /></div>;
}

type RowRenderer<K extends ChatRow['kind']> = (props: RowProps<K>) => JSX.Element | null;

const ROW_RENDERERS: { [K in ChatRow['kind']]: RowRenderer<K> } = {
  divider: DividerRow,
  user: UserRow,
  assistant: AssistantRow,
  subagent: ({ row, dimmed, copyText, ctx }) => (
    <Dimmable dimmed={dimmed} copyText={copyText}><MSubagentBlock row={row} sessionId={ctx.streamKey} /></Dimmable>
  ),
  tools: ({ row, dimmed, copyText, ctx }) => (
    <Dimmable dimmed={dimmed} copyText={copyText}><MToolCallsRow row={row} sessionId={ctx.streamKey} /></Dimmable>
  ),
  notice: ({ row, dimmed, copyText, ctx }) => (
    <Dimmable dimmed={dimmed} copyText={copyText}>
      <ChatNotice level={row.level} text={row.text} authAction={row.authAction} noticeAction={row.noticeAction}
        onNoticeAction={ctx.interactions?.onCancelResume} noticeActionDone={ctx.interactions?.resumeCancelled} />
    </Dimmable>
  ),
  interaction: ({ row, dimmed, copyText, ctx }) => (
    <div style={{ display: 'flex', flexDirection: 'column', ...(dimmed ? DIM : {}) }}>
      <MInteractionRow row={row} interactions={ctx.interactions} />
      <AssistantTurnCopyAction text={copyText} />
    </div>
  ),
  'team-action': ({ row, dimmed, copyText }) => (
    <Dimmable dimmed={dimmed} copyText={copyText}><TeamActionRow action={row.action} touch /></Dimmable>
  ),
  'team-updates': ({ row, dimmed, copyText }) => (
    <Dimmable dimmed={dimmed} copyText={copyText}><TeamUpdateCard row={row} touch /></Dimmable>
  ),
};

function StreamRow(props: RowProps<ChatRow['kind']>): JSX.Element | null {
  // Keyed by kind, so the renderer picked is always the one for the row it is handed.
  const Render = ROW_RENDERERS[props.row.kind] as RowRenderer<ChatRow['kind']>;
  return <Render {...props} />;
}

export function MChatStream({ rows, start = 0, interactions, editing, onLongPress, onShowOriginal, streamKey }: {
  rows: ChatRow[];
  /** First row to mount (see useTranscriptWindow). Rows keep their index into `rows` either way. */
  start?: number;
  interactions?: MChatInteractions;
  /** Identity of the live stream these rows belong to (the session) — a change settles the reveal
   *  instead of pacing the next chat's reply onward from this one's progress. */
  streamKey?: string;
  /** 7b edit mode: the held row rings 编辑中, later rows dim under the 将被回退 badge. */
  editing?: MEditMode | null;
  /** Long-press on a user bubble (opens the 7a action menu), with the bubble's viewport top. Present
   *  ⇒ the sec-7 edit affordances render (long-press menu, 编辑中/将被回退, 已编辑 note). */
  onLongPress?: (rowIndex: number, anchorTop: number) => void;
  /** Tap on the 已编辑 note (opens the original-message sheet). */
  onShowOriginal?: (edited: { originalText: string; originalTs: string }) => void;
}): JSX.Element {
  const assistantCopies = assistantTurnCopyTargets(rows);
  const editingIdx = editing?.rowIndex ?? null;
  const ctx: StreamContext = {
    interactions, streamKey, editing, onShowOriginal,
    editable: !!onLongPress,
    regen: onLongPress ? regenNoteIndexes(rows) : null,
    // Long-press (复制 / 编辑消息) is human-messages-only — agent messages carry no copy.
    holdFor: (row, index) => (onLongPress && editingIdx == null && row.kind === 'user' && !row.systemOrigin
      ? longPressHandlers((anchorTop) => onLongPress(index, anchorTop)) : null),
  };
  return (
    <>
      {rows.slice(start).map((row, j) => {
        const i = start + j;
        return (
          <StreamRow key={row.kind === 'interaction' && row.detail ? `int-${row.detail.id}` : row.kind === 'team-updates' ? `team-${row.id}` : i}
            row={row} index={i} dimmed={editingIdx != null && i > editingIdx} copyText={assistantCopies.get(i)} ctx={ctx} />
        );
      })}
    </>
  );
}

// Client-annotated system line in the stream (scheme 1p L808) — e.g. a real profile switch.
export function SystemLine({ text }: { text: string }): JSX.Element {
  return (
    <div
      style={{
        alignSelf: 'center',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        font: `400 11px ${MONO}`,
        color: MC.muted,
        background: 'var(--material-control-bg)',
        boxShadow: 'var(--material-control-shadow)',
        border: '1px solid var(--proto-line-2)',
        padding: '3px 10px',
        borderRadius: 'var(--r-pill)',
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: MC.run }} />
      {text}
    </div>
  );
}

/** Only the tail of a long transcript is mounted; scrolling toward the top mounts more. The view
 *  opens at the latest message and stays pinned while it streams (the desktop MessageStream's
 *  rule), except just after a tap inside the stream, which may have expanded a row. */
function useTranscriptScroll(props: MChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const win = useTranscriptWindow({ total: props.rows.length, streamKey: props.sessionId, settled: !props.loading, scrollRef });
  const stick = useStickToBottom(scrollRef, contentRef, {
    streamKey: props.sessionId, changes: [props.rows, props.systemLines], freezeMs: TAP_FREEZE_MS,
  });
  const onScroll = (): void => {
    stick.onScroll();
    win.onScroll();
  };
  return { scrollRef, contentRef, win, onScroll, onContentClick: stick.freeze };
}

const HEADER_BOTTOM = `var(${HEADER_BOTTOM_VAR})`;
/** Rows start (and sticky subagent headers pin) 12px under the floating header stack. */
const TRANSCRIPT_TOP = `calc(${HEADER_BOTTOM} + 12px)`;

function MChatTranscript({ props, shellHeight, tailHeight, onShowOriginal }: {
  props: MChatViewProps;
  shellHeight: number;
  tailHeight: number;
  onShowOriginal: (text: string) => void;
}): JSX.Element {
  const { scrollRef, contentRef, win, onScroll, onContentClick } = useTranscriptScroll(props);
  // The transcript dissolves over the 48px above the floating shell instead of sliding under it
  // legibly, so the composer's blur samples the ground rather than smeared text. The fade ends at the
  // shell top (its 20px offset + measured height), and the tail clearance keeps the last row 52px
  // clear of it, so a transcript scrolled to the end stays fully opaque.
  const fadeEdge = `calc(100% - ${shellHeight + 20}px - env(safe-area-inset-bottom))`;
  // Hide text beneath the floating header stack; fade in across the 12px clearance under it.
  // Only the transcript is masked, leaving the floating title and its glass unchanged.
  const transcriptFade = `linear-gradient(to bottom, transparent ${HEADER_BOTTOM}, #000 ${TRANSCRIPT_TOP}, #000 calc(${fadeEdge} - 48px), transparent ${fadeEdge})`;
  return (
    // Plain-block scroll container (like the desktop MessageStream) with an inner flex-column content
    // wrapper — keeps programmatic scrollTop stick-to-bottom reliable in mobile webviews. Isolate
    // sticky headers so their z-index cannot escape over the composer or overlays.
    <div ref={scrollRef} onScroll={onScroll} onClick={onContentClick} data-transcript-scroller style={{ flex: 1, minHeight: 0, overflow: 'auto', scrollbarGutter: 'stable', isolation: 'isolate', maskImage: transcriptFade, WebkitMaskImage: transcriptFade, '--transcript-sticky-top': TRANSCRIPT_TOP } as CSSProperties}>
      <div ref={contentRef} style={{ padding: 'var(--transcript-sticky-top) 16px 0', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {props.transcriptError && props.rows.length === 0 && props.onRetryTranscript && <TranscriptLoadError onRetry={props.onRetryTranscript} />}
        <MChatStream rows={props.rows} start={win.start} interactions={props.interactions} editing={props.editing}
          onLongPress={props.onLongPress} onShowOriginal={(edited) => onShowOriginal(edited.originalText)} streamKey={props.sessionId} />
        <LeadWaitingLine touch />
        {props.systemLines?.map((t, i) => <SystemLine key={i} text={t} />)}
        {/* Tail clearance for the floating composer, which no longer takes flow height. */}
        <div data-composer-clearance style={{ height: `calc(${tailHeight}px + env(safe-area-inset-bottom))`, flex: 'none' }} />
      </div>
    </div>
  );
}

function MChatComposer({ props, shellRef, overlay, selection }: {
  props: MChatViewProps;
  shellRef: ReturnType<typeof useComposerClearance>['composerRef'];
  overlay: ChatOverlay;
  selection: MChatSelectionView;
}): JSX.Element {
  const L = useVocabOptional();
  const takenOver = !!(props.editing || props.rejectBar);
  const commandMenu = !takenOver && props.slashSuggestions?.length && props.onSlashPick
    ? <MobileSlashMenu suggestions={props.slashSuggestions} onPick={props.onSlashPick} />
    : undefined;
  return (
    <MComposer
      shellRef={shellRef}
      placeholder={props.composerPlaceholder ?? (props.attachments.length > 0 ? L.chatAttachPlaceholder : L.chatComposerPh)}
      value={props.composerValue} onChange={props.onComposerChange} onSend={props.onSend} sendEnabled={props.sendEnabled}
      running={props.status.running} onStop={props.onStop} stopEnabled={props.stopEnabled}
      leading={takenOver ? undefined : <ComposerKeys browser={props.browser} overlay={overlay} />}
      tools={takenOver ? null : <ComposerTools selection={props.selection} view={selection} />}
      above={<ComposerAbove props={props} />}
      commandMenu={commandMenu}
      onPlus={() => overlay.toggle('attach')}
      lineUnit={L.chatLineUnit}
      charUnit={L.chatCharUnit}
      tone={props.editing ? 'accent' : props.rejectBar ? 'amber' : 'default'}
    />
  );
}

/** Body region — a position:relative frame holding the scroll transcript + the floating composer,
 *  both anchored to it. The full-screen editor (2b) mounts as an absolute overlay of THIS region;
 *  since the header now floats over the same box, the editor outranks it. */
function MChatBody({ props, overlay, selection }: {
  props: MChatViewProps;
  overlay: ChatOverlay;
  selection: MChatSelectionView;
}): JSX.Element {
  const { composerRef, tailHeight, shellHeight } = useComposerClearance();
  const heldRow = props.msgMenu ? props.rows[props.msgMenu.rowIndex] : undefined;
  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <MChatTranscript props={props} shellHeight={shellHeight} tailHeight={tailHeight}
        onShowOriginal={overlay.showOriginal} />
      <MChatComposer props={props} shellRef={composerRef} overlay={overlay} selection={selection} />
      {/* 7a long-press overlay — an absolute overlay of the BODY region, like the 2b editor above.
          Anchoring the floated bubble to the held one only works against a box whose top is the
          top of the transcript; hanging it off the screen root would put the header (and its
          safe-area inset) inside the coordinate space for no gain. */}
      {props.msgMenu && heldRow && <MsgActionMenu row={heldRow} menu={props.msgMenu} />}
    </div>
  );
}

function headerContextControl(props: MChatViewProps, onOpen: () => void): ReactNode {
  if (!props.contextUsageSupported && props.contextUsage == null) return null;
  return (
    <ContextUsageRing
      usage={props.contextUsage ?? null}
      variant="mobile"
      onClick={onOpen}
      data-context-usage-position="chat-header"
      data-context-compact-enabled={props.contextCompactAction ? 'true' : undefined}
      style={HEADER_CONTEXT_KEY}
    />
  );
}

export function MChatView(props: MChatViewProps): JSX.Element {
  const overlay = useChatOverlay(props.sessionId ?? '');
  const files = useFilePicker(props.onAddFiles);
  const selection = selectionView(props.selection, useVocabOptional());
  const clearance = useHeaderClearance();
  // Team mode: a lead's team summary floats in a row under the header, inside the measured stack.
  const teamRow = !!props.onOpenWorker && hasActiveWorker(props.workers);
  return (
    <TeamStreamProvider workers={props.workers ?? NO_WORKERS} leadRunning={props.status.running}
      onOpenWorker={props.onOpenWorkerFromChat ?? props.onOpenWorker}>
      <div
        ref={clearance.rootRef}
        data-screen-label="1b chat detail"
        style={{ height: '100%', position: 'relative', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}
      >
        {files.input}
        <div ref={clearance.stackRef} data-chat-header-stack="" style={HEADER_STACK}>
          <MChatHeader title={props.title} parent={props.parent} status={props.status} project={props.project}
            onBack={props.onBack} onMore={() => overlay.toggle('more')}
            contextControl={headerContextControl(props, () => overlay.open('context'))} />
          {props.boardId && <BoardStatusBar boardId={props.boardId} onOpen={() => overlay.open('board')} />}
          {teamRow && <MTeamRow workers={props.workers ?? []} onOpen={() => overlay.open('team')} />}
        </div>
        <MChatBody props={props} overlay={overlay} selection={selection} />
        <MChatOverlays props={props} overlay={overlay} selection={selection} files={files} />
      </div>
    </TeamStreamProvider>
  );
}
