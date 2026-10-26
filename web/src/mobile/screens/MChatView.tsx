import { ChatMediaProvider } from '@/features/media/ChatMediaProvider';
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { SessionInfo, WaitpointInfo } from '@cortex-agent/ui-contract';
import { ChatMarkdown } from '@/design/ChatMarkdown';
import { ContextUsageRing } from '@/features/session/composer/ContextUsageControl';
import { TranscriptLoadError } from '@/features/session/transcript/TranscriptLoadError';
import { useRevealedText } from '@/features/session/transcript/useRevealedText';
import { UnseenJumpPill } from '@/features/session/transcript/UnseenJumpPill';
import { ChatNotice } from '@/features/session/transcript/ChatNotice';
import { SubagentTranscriptDetail } from '@/features/session/transcript/SubagentTranscriptDetail';
import { SubagentBlock } from '@/features/session/transcript/SubagentBlock';
import { ToolCallsRow } from '@/features/session/transcript/ToolCallsRow';
import { SystemHintRow, ThinkingRow } from '@/features/session/transcript/HintRow';
import { EventIcon, EventRow } from '@/features/session/transcript/EventRow';
import { SessionStateLine, TranscriptStatusProvider, WaitpointRow, WorkLog } from '@/features/session/transcript/WorkLog';
import { copyHosts, itemIndexes, layoutTurns, type TurnItem } from '@/features/session/transcript/turn-layout';
import { DecisionList } from '@/features/session/interaction/DecisionRows';
import { fmt, useVocabOptional } from '@/i18n';
import { assistantTurnCopyTargets, liveToolsIndex, regenNoteIndexes, systemOriginDisplay, systemOriginLabel, type ChatRow } from '@/features/session/transcript/transcript-vm';
import { interactionView, emptyAskAnswers, type PlanCardModel } from '@/features/session/interaction/interaction-vm';
import { MBackChevron, MComposer, MC, M_NUM } from '@/mobile/ui/kit';
import { MAskCard, MPlanCard } from './MInteractionCards';
import { AttachmentGroup } from './MChatAttachments';
import { AssistantTurnCopyAction, longPressHandlers, MsgActionMenu } from './MChatMessageActions';
import {
  ComposerAbove, ComposerLeading, ComposerTools, MobileSlashMenu, useFilePicker,
} from './MChatComposerPresentation';
import { MChatOverlays } from './MChatOverlays';
import { selectionView, type MChatSelectionView } from './m-chat-selection';
import { useChatOverlay, type ChatOverlay } from './useChatOverlay';
import type { ChatHeaderStatus } from './m-chat-vm';
import { useComposerClearance } from './useComposerClearance';
import { useMTranscriptScroll } from './useMTranscriptScroll';
import { HEADER_BOTTOM_VAR, useHeaderClearance } from './useHeaderClearance';
import { useNowTick } from '@/lib/useNowTick';
import { BoardActionChatRow } from '@/features/board/BoardChatRows';
import { LeadWaitingLine, TeamActionRow, TeamStreamProvider, TeamUpdateCard } from '@/features/team/TeamStreamRows';
import type { MChatInteractions, MChatViewProps, MEditMode } from './MChatView.types';

export type { MChatInteractions, MEditMode, MMsgMenu, MRejectBar } from './MChatView.types';

// ── floating header — back chevron · status dot + title over a plain-words status line · context ring · ⋯ ───
interface MChatHeaderProps {
  title: string;
  /** Team mode: the worker's lead, a tappable prefix before the title. */
  parent?: { title: string; onSelect: () => void } | null;
  status: ChatHeaderStatus;
  onBack: () => void;
  onMore: () => void;
  /** Context usage, as a bare ring left of ⋯. Absent on a session that reports no window. */
  contextControl?: ReactNode;
}

/** The floating header pill, measured once (useHeaderClearance) so the transcript clears it. */
const HEADER_STACK: CSSProperties = {
  position: 'absolute', top: 'calc(8px + env(safe-area-inset-top))', left: 10, right: 10, zIndex: 5,
  display: 'flex', flexDirection: 'column', gap: 6,
};

const CHAT_HEADER: CSSProperties = {
  position: 'relative', height: 56, flex: 'none',
  display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px',
  borderRadius: 'var(--r-float)', background: MC.glass,
  backdropFilter: MC.glassFilter, WebkitBackdropFilter: MC.glassFilter,
  boxShadow: '0 0 0 1px var(--proto-line), var(--shadow-chrome-float)',
  boxSizing: 'border-box',
};

const HEADER_KEY: CSSProperties = {
  flex: 'none', width: 44, height: 44, border: 0, background: 'transparent', padding: 0,
  borderRadius: 'var(--r-control)', cursor: 'pointer',
};

/** The title row's dot speaks the same status language as the session list: amber while the session
 *  waits on the user, accent while it runs, a faint mark at rest. */
function headerDot(status: ChatHeaderStatus): string {
  if (status.tone === 'waiting') return 'var(--proto-amber)';
  return status.running ? 'var(--proto-accent)' : 'var(--proto-line-3)';
}

/** The header floats over the transcript rather than docking above it, so it is built here instead
 *  of through `MDrillHeader`: that kit header is a flat flex band the other drill screens still
 *  want. */
export function MChatHeader(props: MChatHeaderProps): JSX.Element {
  const vocab = useVocabOptional();
  return (
    <div data-chat-header="true" style={CHAT_HEADER}>
      <button type="button" aria-label={vocab.back} onClick={props.onBack}
        style={{ ...HEADER_KEY, color: MC.ink, display: 'grid', placeItems: 'center' }}>
        <MBackChevron />
      </button>
      <div style={{ flex: 1, minWidth: 0, padding: '0 2px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span data-chat-status-dot={props.status.tone} style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none', background: headerDot(props.status) }} />
          {props.parent && (
            <button type="button" data-lead-crumb="" aria-label={`${vocab.wbTeamOpenLead} · ${props.parent.title}`}
              onClick={props.parent.onSelect}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, maxWidth: '45%', flexShrink: 1,
                padding: 0, border: 0, background: 'transparent', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 15, color: MC.muted }}>
              <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{props.parent.title}</span>
              <span aria-hidden="true" style={{ flex: 'none' }}>/</span>
            </button>
          )}
          <span style={{ minWidth: 0, fontSize: 15.5, fontWeight: 620, color: MC.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {props.title}
          </span>
        </div>
        <MChatStatusLine status={props.status} />
      </div>
      {props.contextControl}
      <button type="button" aria-label={vocab.more} onClick={props.onMore}
        style={{ ...HEADER_KEY, color: 'var(--proto-muted-2)', fontSize: 18, letterSpacing: '1px' }}>
        ⋯
      </button>
    </div>
  );
}

/** Plain words in the UI face, muted — amber while the session waits on the user, matching its dot. */
function MChatStatusLine({ status }: { status: ChatHeaderStatus }): JSX.Element {
  const now = useNowTick(!!status.liveText);
  const text = status.liveText ? status.liveText(now) : status.text;
  return (
    <div data-chat-status-line="true" style={{
      fontSize: 12.5, color: status.tone === 'waiting' ? 'var(--proto-amber-fg)' : MC.muted, marginTop: 1,
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...M_NUM,
    }}>
      {text}
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
function MSubagentBlock({ row, sessionId, background = false }: {
  row: Extract<ChatRow, { kind: 'subagent' }>;
  sessionId?: string;
  background?: boolean;
}): JSX.Element {
  return (
    <SubagentBlock agentType={row.agentType} description={row.description} prompt={row.prompt}
      model={row.model} status={row.status} toolCount={row.toolCount} background={background} clean={row.clean} touch>
      <MSubagentDetail row={row} sessionId={sessionId} />
    </SubagentBlock>
  );
}

/** The desktop tool group in its touch form. */
function MToolCallsRow({ row, sessionId, live = false }: {
  row: Extract<ChatRow, { kind: 'tools' }>;
  sessionId?: string;
  live?: boolean;
}): JSX.Element {
  return <ToolCallsRow calls={row.calls} sessionId={sessionId} live={live} touch />;
}

// ── the message stream (reuses ChatMarkdown; renders attachments above/below bubbles) ──

const NOOP = (): void => {};
const NO_WORKERS: SessionInfo[] = [];
const NO_WAITPOINTS: WaitpointInfo[] = [];

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
function MAssistantBlock({ text, preview, streamKey, ts }: {
  text: string;
  preview?: boolean;
  streamKey?: string;
  ts?: string;
}): JSX.Element | null {
  const shown = useRevealedText(text, !!preview, streamKey);
  if (!shown.trim()) return null;
  return <ChatMediaProvider sessionId={streamKey} ts={ts}><ChatMarkdown text={shown} dropTrailingHr renderMath /></ChatMediaProvider>;
}

/** Interaction row for the mobile stream (scheme 6a/5b/4a-c). Entity rows render the full cards
 *  — pending actionable, resolved sealed in place; expired/cancelled + legacy rows render a
 *  one-line summary. Without handlers the cards render inert. */
function MInteractionRow({ row, interactions }: { row: Extract<ChatRow, { kind: 'interaction' }>; interactions?: MChatInteractions }): JSX.Element {
  const copy = useVocabOptional();
  const v = interactionView(row, copy);
  if (v.kind === 'ask' && v.model.status !== 'pending') {
    const m = v.model;
    return (
      <MSealedAsk count={m.questions.length} time={m.timeLabel}>
        <MAskCard model={m} state={emptyAskAnswers} copy={copy} onPick={NOOP} onToggle={NOOP} onConfirmMulti={NOOP} />
      </MSealedAsk>
    );
  }
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
  if (v.kind === 'plan') return <MPlanInteraction model={v.model} interactions={interactions} />;
  const color = v.tone === 'rejected' ? 'var(--proto-danger)' : v.tone === 'inactive' ? undefined : MC.done;
  const icon = v.tone === 'rejected' ? 'cross' : v.tone === 'inactive' ? 'circle' : 'check';
  return <EventRow touch icon={<EventIcon name={icon} color={color} />} label={v.label} summary={v.text} attrs={{ 'data-interaction-summary': v.tone }} />;
}

function MPlanInteraction({ model: m, interactions }: { model: PlanCardModel; interactions?: MChatInteractions }): JSX.Element {
  const copy = useVocabOptional();
  if (m.status !== 'approved' && m.status !== 'rejected') {
    return <MPlanCard model={m} copy={copy} dimmed={interactions?.rejectingId === m.requestId}
      onApprove={interactions ? () => interactions.onApprove(m) : NOOP}
      onRejectStart={interactions ? () => interactions.onRejectStart(m) : NOOP}
      onOpenRead={interactions ? () => interactions.onOpenRead(m) : NOOP} />;
  }
  const approved = m.status === 'approved';
  return (
    <>
      <EventRow touch icon={<EventIcon name={approved ? 'check' : 'cross'} color={approved ? 'var(--proto-success)' : 'var(--proto-danger)'} />}
        label={approved ? copy.chatPlanApproved : copy.chatPlanRejected} summary={m.title}
        meta={<span style={{ color: 'var(--proto-accent)', fontWeight: 550 }}>{copy.chatPlanView}</span>}
        onClick={interactions ? () => interactions.onOpenRead(m) : undefined}
        attrs={{ 'data-interaction-sealed': approved ? 'plan-approved' : 'plan-rejected' }} />
      {!approved && m.feedback && (
        <div style={{ alignSelf: 'flex-end', maxWidth: '82%', background: MC.inkSolid, color: 'var(--ink-solid-fg)', borderRadius: 'var(--r-float) var(--r-float) 4px var(--r-float)', padding: '9px 13px', fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
          {m.feedback}
        </div>
      )}
    </>
  );
}

/** An answered question: one line that opens back to the questions and answers. */
function MSealedAsk({ count, time, children }: { count: number; time: string | null; children: ReactNode }): JSX.Element {
  const copy = useVocabOptional();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <EventRow touch icon={<EventIcon name={open ? 'chevron' : 'check'} open={open} color={open ? undefined : MC.done} />}
        label={copy.ixAnswered} summary={count === 1 ? copy.chatAskAnsweredOne : fmt(copy.chatAskAnsweredMany, { n: count })}
        meta={time} expanded={open} onClick={() => setOpen((v) => !v)} attrs={{ 'data-interaction-sealed': 'ask' }} />
      {open && children}
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
  return <SystemHintRow origin={row.systemOrigin!} text={row.text} pending={row.pending}
    expandable={systemOriginDisplay(row.systemOrigin!) === 'expandable'} touch />;
}

const DIM: CSSProperties = { opacity: 0.35, pointerEvents: 'none' };

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
  /** Opens a board a chat card names, full screen. */
  onOpenBoard?: (boardId: string) => void;
  /** The tool run that is what the agent is doing right now, or -1 (see liveToolsIndex). */
  liveTools: number;
}

interface RowProps<K extends ChatRow['kind']> {
  row: Extract<ChatRow, { kind: K }>;
  index: number;
  /** 7b edit mode: rows after the held one dim under the 将被回退 badge. */
  dimmed: boolean;
  /** The turn's whole answer when this row closes it; the copy action rides the last row. */
  copyText?: string;
  ctx: StreamContext;
  /** Drawn inside a turn's open work log: working notes read a step quieter. */
  inWork?: boolean;
  /** A subagent still running after its turn ended. */
  background?: boolean;
}

function DividerRow({ row, dimmed }: RowProps<'divider'>): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, ...(dimmed ? { opacity: 0.35 } : {}) }}>
      <div style={{ flex: 1, height: 1, background: 'var(--proto-line)' }} />
      <div style={{ fontSize: 12, fontWeight: 600, color: MC.muted, ...M_NUM }}>{row.text}</div>
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
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--m-amber-ink)', background: MC.amberBg, padding: '2px 7px', borderRadius: 6, ...M_NUM }}>
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
    <span role="button" onClick={onTap} style={{ fontSize: 12, color: MC.muted, cursor: 'pointer' }}>
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
          <span style={{ fontSize: 12, fontWeight: 600, color: MC.run, background: 'var(--proto-accent-bg)', padding: '2px 7px', borderRadius: 6 }}>{L.chatEditingBadge}</span>
        )}
        {row.systemOrigin && (
          <span data-bubble-label="" style={{ fontSize: 12, fontWeight: 600, color: MC.muted }}>{systemOriginLabel(row.systemOrigin, L)}</span>
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

function AssistantRow({ row, index, dimmed, copyText, ctx, inWork }: RowProps<'assistant'>): JSX.Element {
  const L = useVocabOptional();
  return (
    <div data-chat-row={index} data-narration={inWork ? 'true' : undefined} style={{
      fontSize: inWork ? 14 : 15, lineHeight: 1.6, color: inWork ? MC.sub : MC.body, minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word',
      ...(inWork ? { margin: '2px 0' } : {}), ...(dimmed ? DIM : {}),
    }}>
      {/* 由编辑重新生成 — footnote atop the first regenerated reply after an edit */}
      {ctx.regen?.has(index) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: MC.muted, marginBottom: 4 }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--proto-line-3)', flex: 'none' }} />
          {L.msgRegenNote}
        </div>
      )}
      <MAssistantBlock text={row.text} preview={row.preview} streamKey={ctx.streamKey} ts={row.ts} />
      {row.attachments && row.attachments.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <AttachmentGroup attachments={row.attachments} side="left" />
        </div>
      )}
      {row.decisions && row.decisions.length > 0 && (
        <DecisionList decisions={row.decisions} sessionId={ctx.streamKey} touch />
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
  thinking: ({ row, dimmed }) => (
    <Dimmable dimmed={dimmed}><ThinkingRow text={row.text} preview={row.preview} touch /></Dimmable>
  ),
  subagent: ({ row, dimmed, copyText, ctx, background }) => (
    <Dimmable dimmed={dimmed} copyText={copyText}><MSubagentBlock row={row} sessionId={ctx.streamKey} background={background} /></Dimmable>
  ),
  waitpoint: ({ row, dimmed, copyText }) => (
    <Dimmable dimmed={dimmed} copyText={copyText}><WaitpointRow wait={row.wait} touch /></Dimmable>
  ),
  tools: ({ row, index, dimmed, copyText, ctx }) => (
    <Dimmable dimmed={dimmed} copyText={copyText}><MToolCallsRow row={row} sessionId={ctx.streamKey} live={index === ctx.liveTools} /></Dimmable>
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
  'board-action': ({ row, dimmed, copyText, ctx }) => (
    <Dimmable dimmed={dimmed} copyText={copyText}>
      <BoardActionChatRow action={row.action} onOpen={(id) => ctx.onOpenBoard?.(id)} touch />
    </Dimmable>
  ),
};

function StreamRow(props: RowProps<ChatRow['kind']>): JSX.Element | null {
  // Keyed by kind, so the renderer picked is always the one for the row it is handed.
  const Render = ROW_RENDERERS[props.row.kind] as RowRenderer<ChatRow['kind']>;
  return <Render {...props} />;
}

/** Space above an item in a laid-out stream: a new turn stands apart, the rows of one turn sit close. */
function itemGap(item: TurnItem, prev: TurnItem | undefined, rows: ChatRow[]): number {
  if (!prev) return 0;
  if (item.kind === 'row' && rows[item.index].kind === 'divider') return 24;
  if (prev.kind === 'row' && rows[prev.index].kind === 'divider') return 16;
  return item.segment !== prev.segment ? 26 : 6;
}

export function MChatStream({ rows, start = 0, interactions, editing, onLongPress, onShowOriginal, onOpenBoard, streamKey, group = false, live = false }: {
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
  /** A board card's Open: the full-screen board. */
  onOpenBoard?: (boardId: string) => void;
  /** Lay the rows out as turns, as the desktop chat does (see turn-layout). */
  group?: boolean;
  /** The foreground turn is running: its work stays open and its trailing text is the answer so far. */
  live?: boolean;
}): JSX.Element {
  const items = useMemo(() => (group ? layoutTurns(rows, { live }) : null), [rows, group, live]);
  const copies = useMemo(() => {
    // A turn still being written offers nothing to copy until it ends.
    const targets = assistantTurnCopyTargets(rows, { live });
    return items ? copyHosts(items, targets, rows) : targets;
  }, [rows, items, live]);
  const editingIdx = editing?.rowIndex ?? null;
  const liveTools = useMemo(() => liveToolsIndex(rows, !!live), [rows, live]);
  const ctx: StreamContext = {
    interactions, streamKey, editing, onShowOriginal, onOpenBoard, liveTools,
    editable: !!onLongPress,
    regen: onLongPress ? regenNoteIndexes(rows) : null,
    // Long-press (复制 / 编辑消息) is human-messages-only — agent messages carry no copy.
    holdFor: (row, index) => (onLongPress && editingIdx == null && row.kind === 'user' && !row.systemOrigin
      ? longPressHandlers((anchorTop) => onLongPress(index, anchorTop)) : null),
  };
  const rowKey = (row: ChatRow, i: number): string | number =>
    row.kind === 'interaction' && row.detail ? `int-${row.detail.id}` : row.kind === 'team-updates' ? `team-${row.id}` : i;
  const dimmedAt = (i: number): boolean => editingIdx != null && i > editingIdx;
  if (!items) {
    return (
      <>
        {rows.slice(start).map((row, j) => {
          const i = start + j;
          return <StreamRow key={rowKey(row, i)} row={row} index={i} dimmed={dimmedAt(i)} copyText={copies.get(i)} ctx={ctx} />;
        })}
      </>
    );
  }
  const out: JSX.Element[] = [];
  let prev: TurnItem | undefined;
  items.forEach((item, k) => {
    const indexes = itemIndexes(item);
    if (indexes[indexes.length - 1] < start) return;
    const gap = itemGap(item, prev, rows);
    if (gap) out.push(<div key={`gap-${k}`} aria-hidden="true" style={{ height: gap, flex: 'none' }} />);
    prev = item;
    if (item.kind === 'row') {
      const row = rows[item.index];
      out.push(<StreamRow key={rowKey(row, item.index)} row={row} index={item.index} dimmed={dimmedAt(item.index)}
        copyText={copies.get(k)} ctx={ctx} background={item.role === 'pinned' && row.kind === 'subagent'} />);
      return;
    }
    out.push(
      <div key={item.key} style={dimmedAt(item.indexes[0]) ? DIM : undefined}>
        <WorkLog stats={item.stats} live={item.live} touch footer={<AssistantTurnCopyAction text={copies.get(k)} />}>
          {item.indexes.map((i) => <StreamRow key={rowKey(rows[i], i)} row={rows[i]} index={i} dimmed={false} ctx={ctx} inWork />)}
        </WorkLog>
      </div>,
    );
  });
  // One flex column of its own, so the turn spacing above is the only spacing between items.
  return <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>{out}</div>;
}

// Client-annotated system line in the stream (scheme 1p L808) — e.g. a model switch.
export function SystemLine({ text }: { text: string }): JSX.Element {
  return (
    <div
      style={{
        alignSelf: 'center',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        color: MC.muted,
        background: 'var(--material-control-bg)',
        boxShadow: 'var(--material-control-shadow)',
        border: '1px solid var(--proto-line-2)',
        padding: '3px 10px',
        borderRadius: 'var(--r-pill)',
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: MC.faint }} />
      {text}
    </div>
  );
}

const HEADER_BOTTOM = `var(${HEADER_BOTTOM_VAR})`;
/** Rows start (and sticky subagent headers pin) 12px under the floating header stack. */
const TRANSCRIPT_TOP = `calc(${HEADER_BOTTOM} + 12px)`;

function MChatTranscript({ props, shellHeight, tailHeight, onShowOriginal, onOpenBoard }: {
  props: MChatViewProps;
  shellHeight: number;
  tailHeight: number;
  onShowOriginal: (text: string) => void;
  onOpenBoard: (boardId: string) => void;
}): JSX.Element {
  // The composer floats over the scroller: a reply under it is not on screen yet.
  const { scrollRef, contentRef, win, unseen, onScroll, onContentClick } = useMTranscriptScroll(props, shellHeight + 20);
  // The transcript dissolves over the 48px above the floating shell instead of sliding under it
  // legibly, so the composer's blur samples the ground rather than smeared text. The fade ends at the
  // shell top (its 20px offset + measured height), and the tail clearance keeps the last row 52px
  // clear of it, so a transcript scrolled to the end stays fully opaque.
  const fadeEdge = `calc(100% - ${shellHeight + 20}px - env(safe-area-inset-bottom))`;
  // Hide text beneath the floating header stack; fade in across the 12px clearance under it.
  // Only the transcript is masked, leaving the floating title and its glass unchanged.
  const transcriptFade = `linear-gradient(to bottom, transparent ${HEADER_BOTTOM}, #000 ${TRANSCRIPT_TOP}, #000 calc(${fadeEdge} - 48px), transparent ${fadeEdge})`;
  return (
    <>
      {/* Plain-block scroll container (like the desktop MessageStream) with an inner flex-column
          content wrapper — keeps programmatic scrollTop stick-to-bottom reliable in mobile webviews.
          Isolate sticky headers so their z-index cannot escape over the composer or overlays. */}
      <div ref={scrollRef} onScroll={onScroll} onClick={onContentClick} data-transcript-scroller style={{ flex: 1, minHeight: 0, overflow: 'auto', scrollbarGutter: 'stable', isolation: 'isolate', maskImage: transcriptFade, WebkitMaskImage: transcriptFade, '--transcript-sticky-top': TRANSCRIPT_TOP } as CSSProperties}>
        <div ref={contentRef} style={{ padding: 'var(--transcript-sticky-top) 16px 0', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {props.transcriptError && props.rows.length === 0 && props.onRetryTranscript && <TranscriptLoadError onRetry={props.onRetryTranscript} />}
          <MChatStream rows={props.rows} start={win.start} interactions={props.interactions} editing={props.editing}
            onLongPress={props.onLongPress} onShowOriginal={(edited) => onShowOriginal(edited.originalText)} onOpenBoard={onOpenBoard}
            streamKey={props.sessionId} group live={props.live} />
          <LeadWaitingLine touch />
          <SessionStateLine running={!!props.live} touch />
          {props.systemLines?.map((t, i) => <SystemLine key={i} text={t} />)}
          {/* Tail clearance for the floating composer, which no longer takes flow height. */}
          <div data-composer-clearance style={{ height: `calc(${tailHeight}px + env(safe-area-inset-bottom))`, flex: 'none' }} />
        </div>
      </div>
      <UnseenJumpPill target={unseen.target} onJump={unseen.jump} touch bottom={`calc(${shellHeight + 30}px + env(safe-area-inset-bottom))`} />
    </>
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
      leading={takenOver ? undefined : <ComposerLeading onClick={() => overlay.toggle('attach')} />}
      tools={takenOver ? null : <ComposerTools selection={props.selection} view={selection} />}
      above={<ComposerAbove props={props} overlay={overlay} />}
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
        onShowOriginal={overlay.showOriginal} onOpenBoard={overlay.openBoard} />
      <MChatComposer props={props} shellRef={composerRef} overlay={overlay} selection={selection} />
      {/* 7a long-press overlay — an absolute overlay of the BODY region, like the 2b editor above.
          Anchoring the floated bubble to the held one only works against a box whose top is the
          top of the transcript; hanging it off the screen root would put the header (and its
          safe-area inset) inside the coordinate space for no gain. */}
      {props.msgMenu && heldRow && <MsgActionMenu row={heldRow} menu={props.msgMenu} />}
    </div>
  );
}

/** Context usage sits in the header, left of ⋯. A bare ring: the header pill is already the frame,
 *  and the ring is itself the button (nesting it in a round wrapper would nest a button in a button). */
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

const HEADER_CONTEXT_KEY: CSSProperties = {
  width: 44, height: 44, borderRadius: '50%', background: 'transparent', border: 0, flexShrink: 0,
  boxSizing: 'border-box', justifyContent: 'center',
};

export function MChatView(props: MChatViewProps): JSX.Element {
  const overlay = useChatOverlay(props.sessionId ?? '');
  const files = useFilePicker(props.onAddFiles);
  const selection = selectionView(props.selection, useVocabOptional());
  const clearance = useHeaderClearance();
  return (
    <TeamStreamProvider workers={props.workers ?? NO_WORKERS} leadRunning={props.status.running}
      onOpenWorker={props.onOpenWorkerFromChat ?? props.onOpenWorker}>
      <TranscriptStatusProvider backgroundRunning={!!props.backgroundRunning} waitpoints={props.waitpoints?.waitpoints ?? NO_WAITPOINTS}>
      <div
        ref={clearance.rootRef}
        data-screen-label="1b chat detail"
        style={{ height: '100%', position: 'relative', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}
      >
        {files.input}
        <div ref={clearance.stackRef} data-chat-header-stack="" style={HEADER_STACK}>
          <MChatHeader title={props.title} parent={props.parent} status={props.status}
            onBack={props.onBack} onMore={() => overlay.toggle('more')}
            contextControl={headerContextControl(props, () => overlay.open('context'))} />
        </div>
        <MChatBody props={props} overlay={overlay} selection={selection} />
        <MChatOverlays props={props} overlay={overlay} selection={selection} files={files} />
      </div>
      </TranscriptStatusProvider>
    </TeamStreamProvider>
  );
}
