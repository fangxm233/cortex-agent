// input:  React, mobile presentation props, shared view models
// output: MChatView
// pos:    Mobile chat materials with stable sticky tool headers
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChatMarkdown } from '@/features/workbench/ChatMarkdown';
import { ContextUsageRing } from '@/features/workbench/ContextUsageControl';
import { useRevealedText } from '@/features/workbench/useRevealedText';
import { useToolCallOverflow } from '@/features/workbench/useToolCallOverflow';
import { ChatNotice } from '@/features/workbench/ChatNotice';
import { SubagentTranscriptDetail } from '@/features/workbench/SubagentTranscriptDetail';
import { useVocab } from '@/i18n';
import { assistantTurnCopyTargets, regenNoteIndexes, systemOriginLabel, systemOriginSummary, type ChatRow } from '@/features/workbench/transcript-vm';
import { modelLabel } from '@/features/workbench/model-label';
import { interactionView, emptyAskAnswers } from '@/features/workbench/interaction-vm';
import { toolChips } from '@/mobile/screens/mobile-session-vm';
import { MComposer, MBottomSheet, MDot, MC, MONO } from '@/mobile/ui/kit';
import { MAskCard, MPlanCard, M_INT_COPY } from './MInteractionCards';
import { MDecisionCardGroup } from './MDecisionCards';
import { AttachmentGroup } from './MChatAttachments';
import { AssistantTurnCopyAction, longPressHandlers, MsgActionMenu } from './MChatMessageActions';
import {
  AttachMenu, BrowserChip, CommissionChip, ComposerAbove, ComposerLeading, ComposerTools, MobileSlashMenu,
} from './MChatComposerPresentation';
import { AgentSheet, BrowserSheet, CommissionSheet, ContextUsageSheet, MoreMenu, SelectionSheet, SessionIdSheet, SessionStatsSheet } from './MChatSheets';
import type { ChatHeaderStatus } from './m-chat-vm';
import type { MChatEditCopy, MChatInteractions, MChatViewProps, MEditMode } from './MChatView.types';

export { AgentSheet, BrowserSheet, CommissionSheet, ContextUsageSheet, MoreMenu, SelectionSheet, SessionIdSheet, SessionStatsSheet } from './MChatSheets';
export { AttachMenu } from './MChatComposerPresentation';
export { EditBar, MsgActionMenu } from './MChatMessageActions';
export type {
  BrowserSheetItem, CommissionSheetItem, MChatCopy, MChatEditCopy, MChatInteractions, MChatViewProps,
  MEditMode, MMsgMenu, MRejectBar,
} from './MChatView.types';

// ── floating header — back chevron · title + status line · context ring · ⋯ ───
interface MChatHeaderProps {
  title: string;
  status: ChatHeaderStatus;
  /** Project the session belongs to; prefixes the status line when known. */
  project?: string;
  onBack: () => void;
  onMore: () => void;
  /** Context usage, as a round key left of ⋯. Absent on a session that reports no window. */
  contextControl?: ReactNode;
}

const CHAT_HEADER: CSSProperties = {
  position: 'absolute', top: 'calc(8px + env(safe-area-inset-top))', left: 12, right: 12, height: 52,
  zIndex: 5, display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px 0 4px',
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
  return (
    <div data-chat-header="true" style={CHAT_HEADER}>
      <button type="button" aria-label="Back" onClick={props.onBack}
        style={{ ...HEADER_KEY, color: 'var(--proto-accent)', display: 'grid', placeItems: 'center' }}>
        <BackChevron />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none', background: props.status.tone === 'waiting' ? 'var(--proto-amber)' : props.status.running ? 'var(--proto-accent)' : 'var(--proto-line-3)', animation: props.status.running ? 'cxpulse 1.6s ease-in-out infinite' : undefined }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: MC.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {props.title}
          </span>
        </div>
        <MChatStatusLine {...props} />
      </div>
      {props.contextControl}
      <button type="button" aria-label="More" onClick={props.onMore}
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
  return (
    <div data-chat-status-line="true" style={{ font: `400 11px ${MONO}`, color: MC.muted, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      {project ? `${project} · ${status.text}` : status.text}
    </div>
  );
}

// The ⋯ menu exposes the Session ID sheet plus, once the session has run, its whole-session stats.
// ── collapsed/expandable tool-call row (scheme 1b L146; tap to expand) ─────────
const MOBILE_TOOL_GAP = 7;
const mobileToolChipStyle = {
  font: `400 11px ${MONO}`, background: MC.glassRaised,
  border: '1px solid var(--proto-line)', padding: '1px 7px', borderRadius: 5, flex: 'none',
} as const;
const mobileToolStripStyle = {
  display: 'flex', alignItems: 'center', gap: MOBILE_TOOL_GAP,
  flex: 1, minWidth: 0, overflow: 'hidden', position: 'relative',
} as const;
const mobileToolMeasureStyle = {
  ...mobileToolStripStyle,
  position: 'absolute', visibility: 'hidden', pointerEvents: 'none',
  width: 'max-content', overflow: 'visible',
} as const;
const mobileToolOverflowStyle = {
  font: `500 11px ${MONO}`, color: 'var(--proto-muted)', flex: 'none',
} as const;

function MobileToolChip({ name }: { name: string }): JSX.Element {
  return <span style={mobileToolChipStyle}>{name}</span>;
}

function CollapsedToolCalls({ count, calls, unit, onExpand }: {
  count: number;
  calls: { kind: string; input: string }[];
  unit: string;
  onExpand: () => void;
}): JSX.Element {
  const labels = calls.map((call) => call.kind);
  const { containerRef, measureRef, layout } = useToolCallOverflow(labels, MOBILE_TOOL_GAP);
  const chips = toolChips(calls, layout);
  return (
    <div onClick={onExpand} style={{ display: 'flex', alignItems: 'center', gap: MOBILE_TOOL_GAP, minHeight: 44, fontSize: 12, color: MC.muted, flexWrap: 'nowrap', whiteSpace: 'nowrap', overflow: 'hidden', cursor: 'pointer' }}>
      <span style={{ fontSize: 8.5, flex: 'none' }}>▸</span>
      <span style={{ flex: 'none' }}>{count} {unit}</span>
      <span ref={containerRef} style={mobileToolStripStyle}>
        {chips.names.map((name, index) => <MobileToolChip key={index} name={name} />)}
        {chips.overflow > 0 ? <span style={mobileToolOverflowStyle}>+{chips.overflow}</span> : null}
        <span ref={measureRef} aria-hidden="true" style={mobileToolMeasureStyle}>
          {labels.map((name, index) => <MobileToolChip key={index} name={name} />)}
          <span style={mobileToolOverflowStyle}>+{calls.length}</span>
        </span>
      </span>
    </div>
  );
}

function ExpandedToolCalls({ count, calls, unit, onCollapse }: {
  count: number;
  calls: { kind: string; input: string }[];
  unit: string;
  onCollapse: () => void;
}): JSX.Element {
  return (
    <div style={{ background: 'var(--proto-rail)', border: `1px solid ${MC.cardBorder}`, borderRadius: 'var(--r-chip)', overflow: 'hidden' }}>
      <div onClick={onCollapse} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: MC.muted, padding: '6px 11px', minHeight: 44, boxSizing: 'border-box', cursor: 'pointer' }}>
        <span style={{ fontSize: 8.5 }}>▾</span>
        <span>{count} {unit}</span>
      </div>
      {calls.map((call, index) => (
        <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5.5px 11px', borderTop: `1px solid ${MC.divider}` }}>
          <span style={{ font: `600 11px ${MONO}`, color: 'var(--proto-muted)', background: 'var(--proto-gray)', padding: '1.5px 7px', borderRadius: 5, flex: 'none' }}>{call.kind}</span>
          <span style={{ font: `400 11px ${MONO}`, color: MC.body, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{call.input}</span>
        </div>
      ))}
    </div>
  );
}

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
function MSubagentRows({ rows, unit }: { rows: ChatRow[]; unit: string }): JSX.Element {
  return <>{rows.map((row, index) => {
    if (row.kind === 'tools' && row.count > 0) {
      return <ToolCallsRow key={index} count={row.count} calls={row.calls} unit={unit} />;
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

function MSubagentDetail({ row, unit, sessionId }: {
  row: Extract<ChatRow, { kind: 'subagent' }>; unit: string; sessionId?: string;
}): JSX.Element {
  if (row.detailMode !== 'lazy' || !row.hasDetails || !sessionId) {
    return <MSubagentRows rows={row.children} unit={unit} />;
  }
  return <SubagentTranscriptDetail sessionId={sessionId} subagentId={row.id}
    fallbackRows={row.children}
    render={(rows) => <MSubagentRows rows={rows} unit={unit} />} />;
}

function MSubagentBlock({ row, unit, sessionId }: {
  row: Extract<ChatRow, { kind: 'subagent' }>;
  unit: string;
  sessionId?: string;
}): JSX.Element {
  const L = useVocab();
  const [expanded, setExpanded] = useState(false);
  const label = row.description || row.agentType || L.subagentFallbackLabel;
  return (
    <div style={{ background: 'var(--proto-rail)', border: `1px solid ${MC.cardBorder}`, borderRadius: 'var(--r-chip)' }}>
      <div
        onClick={() => setExpanded(!expanded)}
        role="button"
        aria-expanded={expanded}
        style={{ position: 'sticky', top: 0, zIndex: 1, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 7, padding: '6px 11px', minHeight: 44, boxSizing: 'border-box', borderRadius: 'var(--r-chip) var(--r-chip) 0 0', fontSize: 11.5, color: MC.muted, background: MC.card, minWidth: 0 }}
      >
        <MDot
          color={row.status === 'running' ? 'var(--proto-accent)' : 'var(--proto-success)'}
          pulse={row.status === 'running'}
        />
        <span style={{ font: `600 11px ${MONO}`, color: 'var(--proto-muted)', background: 'var(--proto-gray)', padding: '1.5px 7px', borderRadius: 5, flex: 'none' }}>
          {row.agentType || L.subagentFallbackLabel}
        </span>
        {row.model ? (
          <span style={{ font: `600 11px ${MONO}`, color: MC.muted, border: '1px solid var(--proto-line-2)', padding: '1.5px 7px', borderRadius: 5, flex: 'none' }}>
            {modelLabel(row.model)}
          </span>
        ) : null}
        <span style={{ font: `400 11px ${MONO}`, color: MC.body, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: '1 1 100px' }}>{label}</span>
        <span style={{ font: `400 11px ${MONO}`, flex: 'none', marginLeft: 'auto' }}>{`${row.toolCount} ${unit}`}</span>
      </div>
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 11px 10px', borderTop: `1px solid ${MC.hairline}` }}>
          {row.prompt ? (
            <div>
              <div style={{ font: `600 11px ${MONO}`, color: MC.muted, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                {L.subagentPromptLabel}
              </div>
              <pre style={{ margin: 0, font: `400 11px/1.55 ${MONO}`, color: MC.body, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                {row.prompt}
              </pre>
            </div>
          ) : null}
          <MSubagentDetail row={row} unit={unit} sessionId={sessionId} />
        </div>
      )}
    </div>
  );
}

function ToolCallsRow({ count, calls, unit }: {
  count: number;
  calls: { kind: string; input: string }[];
  unit: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  if (!expanded) {
    return <CollapsedToolCalls count={count} calls={calls} unit={unit} onExpand={() => setExpanded(true)} />;
  }
  return <ExpandedToolCalls count={count} calls={calls} unit={unit} onCollapse={() => setExpanded(false)} />;
}

// ── the message stream (reuses ChatMarkdown; renders attachments above/below bubbles) ──

const NOOP = (): void => {};

/**
 * One assistant block. `preview` marks the block being written RIGHT NOW (the token-level
 * accumulation) — the only row the smooth reveal paces, using the same rule and the same frame loop
 * as the desktop chat (`features/workbench/reveal-pacing` + `useRevealedText`). `streaming` cannot
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
  const v = interactionView(row);
  const copy = interactions?.copy ?? M_INT_COPY.zh;
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
        onCustom={() => interactions?.onAskCustom(m)}
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
  const summary = systemOriginSummary(row.text);
  return (
    <div
      data-system-origin={row.systemOrigin}
      style={{
        display: 'flex', alignItems: 'center', gap: 7, padding: '2px 0',
        opacity: row.pending ? 0.55 : 1,
      }}
    >
      <span aria-hidden="true" style={{ width: 3, alignSelf: 'stretch', minHeight: 13, borderRadius: 2, background: MC.divider, flexShrink: 0 }} />
      <span style={{ font: `600 11px ${MONO}`, letterSpacing: '.04em', color: MC.muted, flexShrink: 0 }}>
        {systemOriginLabel(row.systemOrigin!, L)}
      </span>
      {summary && (
        <span style={{ fontSize: 11, color: MC.muted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </span>
      )}
    </div>
  );
}

export function MChatStream({ rows, toolCallsUnit, copyLabel, copiedLabel, interactions, editCopy, editing, onLongPress, onShowOriginal, streamKey }: {
  rows: ChatRow[];
  toolCallsUnit: string;
  copyLabel: string;
  copiedLabel: string;
  interactions?: MChatInteractions;
  /** Identity of the live stream these rows belong to (the session) — a change settles the reveal
   *  instead of pacing the next chat's reply onward from this one's progress. */
  streamKey?: string;
  /** Present → the sec-7 edit affordances render (long-press menu, 编辑中/将被回退, 已编辑 note). */
  editCopy?: MChatEditCopy;
  /** 7b edit mode: the held row rings 编辑中, later rows dim under the 将被回退 badge. */
  editing?: MEditMode | null;
  /** Long-press on a user/assistant bubble (opens the 7a action menu), with the bubble's viewport top. */
  onLongPress?: (rowIndex: number, anchorTop: number) => void;
  /** Tap on the 已编辑 note (opens the original-message sheet). */
  onShowOriginal?: (edited: { originalText: string; originalTs: string }) => void;
}): JSX.Element {
  const regenIdx = editCopy ? regenNoteIndexes(rows) : null;
  const assistantCopies = assistantTurnCopyTargets(rows);
  const editingIdx = editing?.rowIndex ?? null;
  return (
    <>
      {rows.map((row, i) => {
        const dimmed = editingIdx != null && i > editingIdx;
        const isEditingRow = editingIdx === i;
        // Long-press affordance (复制 / 编辑消息) is user-messages-only — agent messages carry no copy.
        const canHold = !!editCopy && !!onLongPress && editingIdx == null && row.kind === 'user' && !row.systemOrigin;
        const hold = canHold ? longPressHandlers((anchorTop) => onLongPress!(i, anchorTop)) : null;
        return (
        <Fragment key={row.kind === 'interaction' && row.detail ? `int-${row.detail.id}` : i}>
          {row.kind === 'divider' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, ...(dimmed ? { opacity: 0.35 } : {}) }}>
              <div style={{ flex: 1, height: 1, background: 'var(--proto-line)' }} />
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', color: MC.muted }}>{row.text}</div>
              <div style={{ flex: 1, height: 1, background: 'var(--proto-line)' }} />
            </div>
          )}
          {row.kind === 'user' && row.systemOrigin && (
            <div style={dimmed ? { opacity: 0.35, pointerEvents: 'none' } : undefined}>
              <MSystemHintRow row={row} />
              {/* The hint line is the machine steering itself INSIDE the turn, so it can be the
                  turn's last row while the reply is still running — the copy action rides it so it
                  stays at the bottom of the answer instead of above the hints. */}
              <AssistantTurnCopyAction text={assistantCopies.get(i)} label={copyLabel} copiedLabel={copiedLabel} />
            </div>
          )}
          {row.kind === 'user' && !row.systemOrigin && (
            <>
              {row.attachments && row.attachments.length > 0 && <AttachmentGroup attachments={row.attachments} />}
              <div style={{ alignSelf: 'flex-end', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, maxWidth: '84%', ...(dimmed ? { opacity: 0.35, pointerEvents: 'none' as const } : {}) }}>
                {/* 7b — the bubble being edited rings accent + 编辑中 badge */}
                {isEditingRow && editCopy && (
                  <span style={{ font: `600 11px ${MONO}`, color: MC.run, background: 'var(--proto-accent-bg)', padding: '2px 7px', borderRadius: 4 }}>{editCopy.editingBadge}</span>
                )}
                <div
                  {...(hold ?? {})}
                  data-msg-bubble={canHold ? i : undefined}
                  style={{
                    background: 'var(--material-card-bg)',
                    border: '1px solid var(--proto-line)',
                    // A message written into the running turn's backend that the model has not read
                    // yet dims its TEXT and nothing else — same bubble, full opacity, no icon, badge
                    // or spinner. The row is provisional, not disabled or failing, and any marker
                    // heavier than the ink would read as one. It clears the instant it is delivered.
                    color: row.pending ? MC.muted : MC.ink,
                    borderRadius: '18px 18px 6px 18px',
                    padding: '10px 14px',
                    fontSize: 15,
                    lineHeight: 1.5,
                    boxShadow: 'var(--material-card-shadow)',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'break-word',
                    wordBreak: 'break-word',
                    WebkitUserSelect: canHold ? 'none' : undefined,
                    userSelect: canHold ? 'none' : undefined,
                    WebkitTouchCallout: canHold ? 'none' : undefined,
                    ...(isEditingRow ? { boxShadow: `var(--material-card-shadow), 0 0 0 1.5px ${MC.run}` } : {}),
                  } as React.CSSProperties}
                >
                  {row.text}
                </div>
                {/* 已编辑 note — tap opens the original-message sheet */}
                {editCopy && row.edited && !isEditingRow && (
                  <span
                    role="button"
                    onClick={onShowOriginal ? () => onShowOriginal(row.edited!) : undefined}
                    style={{ font: `400 11px ${MONO}`, color: MC.muted, cursor: 'pointer' }}
                  >
                    <span style={{ borderBottom: `1px dotted ${MC.muted}` }}>{editCopy.edited}</span>
                  </span>
                )}
              </div>
              {/* 7b — the 将被回退 badge opens the dimmed tail right after the edited bubble */}
              {isEditingRow && editCopy && editing && (
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <span style={{ font: `600 11px ${MONO}`, color: 'var(--m-amber-ink)', background: MC.amberBg, padding: '2px 7px', borderRadius: 4 }}>
                    {editCopy.willRewind(editing.replies, editing.toolCalls)}
                  </span>
                </div>
              )}
            </>
          )}
          {row.kind === 'subagent' && (
            <div style={dimmed ? { opacity: 0.35, pointerEvents: 'none' } : undefined}>
              <MSubagentBlock row={row} unit={toolCallsUnit} sessionId={streamKey} />
              <AssistantTurnCopyAction text={assistantCopies.get(i)} label={copyLabel} copiedLabel={copiedLabel} />
            </div>
          )}
          {row.kind === 'tools' && (
            <div style={dimmed ? { opacity: 0.35, pointerEvents: 'none' } : undefined}>
              <ToolCallsRow count={row.count} calls={row.calls} unit={toolCallsUnit} />
              <AssistantTurnCopyAction text={assistantCopies.get(i)} label={copyLabel} copiedLabel={copiedLabel} />
            </div>
          )}
          {row.kind === 'notice' && (
            <div style={dimmed ? { opacity: 0.35, pointerEvents: 'none' } : undefined}>
              <ChatNotice
                level={row.level} text={row.text} authAction={row.authAction}
                noticeAction={row.noticeAction}
                onNoticeAction={interactions?.onCancelResume}
                noticeActionDone={interactions?.resumeCancelled}
              />
              <AssistantTurnCopyAction text={assistantCopies.get(i)} label={copyLabel} copiedLabel={copiedLabel} />
            </div>
          )}
          {row.kind === 'assistant' && (
            <div
              {...(hold ?? {})}
              style={{ fontSize: 15, lineHeight: 1.6, color: MC.body, minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word', ...(dimmed ? { opacity: 0.35, pointerEvents: 'none' as const } : {}), WebkitUserSelect: canHold ? 'none' : undefined, userSelect: canHold ? 'none' : undefined, WebkitTouchCallout: canHold ? 'none' : undefined } as React.CSSProperties}
            >
              {/* 由编辑重新生成 — footnote atop the first regenerated reply after an edit */}
              {editCopy && regenIdx?.has(i) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, font: `400 11px ${MONO}`, color: MC.muted, marginBottom: 4 }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--proto-line-3)', flex: 'none' }} />
                  {editCopy.regenNote}
                </div>
              )}
              <MAssistantBlock text={row.text} preview={row.preview} streamKey={streamKey} />
              {row.attachments && row.attachments.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <AttachmentGroup attachments={row.attachments} side="left" />
                </div>
              )}
              {row.decisions && row.decisions.length > 0 && (
                <MDecisionCardGroup decisions={row.decisions} sessionId={streamKey} />
              )}
              <AssistantTurnCopyAction text={assistantCopies.get(i)} label={copyLabel} copiedLabel={copiedLabel} />
            </div>
          )}
          {row.kind === 'interaction' && (
            <div style={{ display: 'flex', flexDirection: 'column', ...(dimmed ? { opacity: 0.35, pointerEvents: 'none' as const } : {}) }}>
              <MInteractionRow row={row} interactions={interactions} />
              <AssistantTurnCopyAction text={assistantCopies.get(i)} label={copyLabel} copiedLabel={copiedLabel} />
            </div>
          )}
        </Fragment>
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

export function MChatView(props: MChatViewProps): JSX.Element {
  const { copy } = props;

  // Open the session at the latest message (bottom), and keep it pinned to the bottom as new content
  // streams in — releasing when the user scrolls up, re-pinning once they scroll back down. Mirrors the
  // desktop MessageStream stick-to-bottom behavior.
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // Suppress auto-scroll briefly after user taps inside the stream (e.g. expanding a tool row),
  // so expanded content doesn't scroll out of view on the next streaming tick.
  const tapFreezeUntil = useRef(0);
  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  const onContentClick = (): void => {
    tapFreezeUntil.current = Date.now() + 800;
  };
  // After every content change (entry, streaming delta, profile system-line) keep the view pinned to
  // the bottom IF the user hasn't scrolled up — identical to the desktop MessageStream effect.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current && Date.now() >= tapFreezeUntil.current) el.scrollTop = el.scrollHeight;
  }, [props.rows, props.systemLines]);

  // …and keep it pinned while the content GROWS between row changes. Token-level streaming reveals
  // the reply character by character, so the block gets taller many times per row change; without
  // this the line being written slides under the bottom edge and snaps back only when the next delta
  // lands, which reads as a twitch under otherwise smooth text. Observing the content box catches
  // every cause of growth (the reveal, a late-loading image, markdown reflow) and writes scrollTop
  // directly — no React state, so it costs no render. Mirrors the desktop MessageStream observer,
  // and respects the same tap freeze as the row effect above.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current && Date.now() >= tapFreezeUntil.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const commandMenu = !props.editing && !props.rejectBar && props.slashSuggestions?.length && props.onSlashPick
    ? <MobileSlashMenu suggestions={props.slashSuggestions} onPick={props.onSlashPick} />
    : undefined;

  return (
    <div
      data-screen-label="1b 会话详情"
      style={{ height: '100%', position: 'relative', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}
    >
      <MChatHeader
        title={props.title}
        status={props.status}
        project={props.project}
        onBack={props.onBack}
        onMore={props.onMoreToggle}
        contextControl={(props.contextUsageSupported || props.contextUsage != null) ? (
          <ContextUsageRing
            usage={props.contextUsage ?? null}
            variant="mobile"
            lang={props.contextUsageLang ?? 'en'}
            onClick={props.onContextUsageOpen}
            data-context-usage-position="chat-header"
            data-context-compact-enabled={props.contextCompactAction ? 'true' : undefined}
            style={HEADER_CONTEXT_KEY}
          />
        ) : null}
      />
      {/* Body region — a position:relative frame holding the scroll transcript + the floating
          composer, both anchored to it. The full-screen editor (2b) mounts as an absolute overlay of
          THIS region; since the header now floats over the same box, the editor outranks it. */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Plain-block scroll container (like the desktop MessageStream) with an inner flex-column
            content wrapper — keeps programmatic scrollTop stick-to-bottom reliable in mobile webviews.
            Isolate sticky headers so their z-index cannot escape over the composer or overlays. */}
        <div ref={scrollRef} onScroll={onScroll} onClick={onContentClick} style={{ flex: 1, minHeight: 0, overflow: 'auto', isolation: 'isolate' }}>
          {/* 72px = the floating header's 8px top + 52px height + 12px clearance. */}
          <div ref={contentRef} style={{ padding: 'calc(72px + env(safe-area-inset-top)) 16px 0', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <MChatStream
              rows={props.rows}
              toolCallsUnit={copy.toolCallsUnit}
              copyLabel={copy.copy}
              copiedLabel={copy.copied}
              interactions={props.interactions}
              editCopy={props.editCopy}
              editing={props.editing}
              onLongPress={props.onLongPress}
              onShowOriginal={props.onShowOriginal}
              streamKey={props.streamKey}
            />
            {props.inlineThreadCard}
            {props.systemLines?.map((t, i) => (
              <SystemLine key={i} text={t} />
            ))}
            {/* Tail clearance for the floating composer, which no longer takes flow height. */}
            <div style={{ height: 'calc(150px + env(safe-area-inset-bottom))', flex: 'none' }} />
          </div>
        </div>
        <MComposer
          placeholder={props.composerPlaceholder ?? (props.attachments.length > 0 ? copy.attachPlaceholder : copy.composerPh)}
          value={props.composerValue}
          onChange={props.onComposerChange}
          onSend={props.onSend}
          sendEnabled={props.sendEnabled}
          running={props.status.running}
          onStop={props.onStop}
          stopEnabled={props.stopEnabled}
          leading={props.editing || props.rejectBar ? undefined : (
            <>
              <ComposerLeading onClick={props.onPlus} />
              {props.browserDevice && <BrowserChip device={props.browserDevice}
                label={copy.attachBrowser} onClick={props.onOpenBrowser} />}
              {props.commissionValue && <CommissionChip value={props.commissionValue}
                text={props.commissionLabel || copy.attachCommission}
                label={copy.attachCommission} onClick={props.onOpenCommission} />}
            </>
          )}
          tools={<ComposerTools props={props} />}
          above={<ComposerAbove props={props} />}
          commandMenu={commandMenu}
          onPlus={props.onPlus}
          lineUnit={copy.lineUnit}
          charUnit={copy.charUnit}
          tone={props.editing ? 'accent' : props.rejectBar ? 'amber' : 'default'}
        />
        {/* 7a long-press overlay — an absolute overlay of the BODY region, like the 2b editor above.
            Anchoring the floated bubble to the held one only works against a box whose top is the
            top of the transcript; hanging it off the screen root would put the header (and its
            safe-area inset) inside the coordinate space for no gain. */}
        {props.msgMenu && props.editCopy && props.rows[props.msgMenu.rowIndex] && (
          <MsgActionMenu row={props.rows[props.msgMenu.rowIndex]} menu={props.msgMenu} copy={props.editCopy} />
        )}
      </div>
      {props.moreOpen && (
        <MoreMenu
          copy={copy}
          onClose={props.onMoreClose}
          onSessionId={() => {
            props.onMoreClose();
            props.onSessionIdOpen();
          }}
          onSessionStats={props.sessionStatsRows?.length
            ? () => {
              props.onMoreClose();
              props.onSessionStatsOpen();
            }
            : undefined}
        />
      )}
      {props.sessionStatsOpen && props.sessionStatsRows?.length && (
        <SessionStatsSheet copy={copy} rows={props.sessionStatsRows} onClose={props.onSessionStatsClose} />
      )}
      {props.sessionIdOpen && (
        <SessionIdSheet
          copy={copy}
          cortexId={props.cortexId}
          backendUuid={props.backendUuid}
          onClose={props.onSessionIdClose}
        />
      )}
      {props.originalSheet && props.editCopy && (
        <MBottomSheet onClose={props.originalSheet.onClose}>
          <div style={{ font: `600 11px ${MONO}`, color: MC.muted, letterSpacing: '.05em', padding: '0 2px 8px' }}>{props.editCopy.original}</div>
          <div style={{ background: 'var(--proto-card)', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-card)', padding: '11px 13px', fontSize: 13, lineHeight: 1.6, color: MC.body, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', maxHeight: '50vh', overflow: 'auto' }}>
            {props.originalSheet.text}
          </div>
        </MBottomSheet>
      )}
      {props.attachMenuOpen && (
        <AttachMenu
          copy={copy}
          onClose={props.onAttachClose}
          onCamera={props.onCamera}
          onLibrary={props.onLibrary}
          onFile={props.onFile}
          browser={(props.onOpenBrowser || props.browserDevice) ? { device: props.browserDevice ?? null, onOpen: props.onOpenBrowser } : undefined}
          commission={(props.onOpenCommission || props.commissionValue) ? { label: props.commissionLabel ?? props.commissionValue ?? null, onOpen: props.onOpenCommission } : undefined}
          onCommands={() => props.onComposerChange('/')}
        />
      )}
      {props.browserSheet && (
        <BrowserSheet
          items={props.browserSheet.items}
          title={props.browserSheet.title}
          current={props.browserDevice ?? null}
          onClose={props.browserSheet.onClose}
          onPick={props.browserSheet.onPick}
        />
      )}
      {props.commissionSheet && (
        <CommissionSheet
          items={props.commissionSheet.items}
          title={props.commissionSheet.title}
          current={props.commissionValue ?? null}
          onClose={props.commissionSheet.onClose}
          onPick={props.commissionSheet.onPick}
        />
      )}
      {props.selectionSheet && (
        <SelectionSheet vm={props.selectionSheet.vm} pending={props.selectionSheet.pending} copy={copy} onClose={props.selectionSheet.onClose} onPick={props.selectionSheet.onPick} />
      )}
      {props.agentSheet && (
        <AgentSheet rows={props.agentSheet.rows} title={props.agentSheet.title} copy={copy} onClose={props.agentSheet.onClose} onPick={props.agentSheet.onPick} />
      )}
      {props.contextUsageOpen && (props.contextUsageSupported || props.contextUsage != null) ? (
        <ContextUsageSheet
          usage={props.contextUsage ?? null}
          lang={props.contextUsageLang ?? 'en'}
          compactAction={props.contextCompactAction}
          onClose={props.onContextUsageClose}
        />
      ) : null}
    </div>
  );
}
