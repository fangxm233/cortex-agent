// input:  mobile chat rows, lazy detail, decisions, Todo, modules
// output: Mobile chat with contained sticky headers and overlays
// pos:    Mobile chat presentation facade and stream renderer
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// @ds-adherence-ignore -- mobile v3 chat surface, chrome extracted 1:1 from scheme-mobile.dc.html
// (1b L136-168 · 1o L753-786 · 1p L799-845 · 5a reject composer L200-218). Raw px/hex/font/svg by
// design §8.3 — the mobile palette is not in the light `proto.*` token set. Pure + presentational:
// every field is a prop, no tRPC. The container (MChatScreen) owns data + mutations + live sync.
// Interaction cards (6a plan / 5b ask / 4a-c sealed) live in MInteractionCards. The composer is a
// unified card: full-width input on top, one toolbar row below (＋ menu left; profile chip, context
// ring and Send/Stop right). Browser opt-in and local slash commands fold into the ＋ menu.
// Collapsed tool calls share Desktop width measurement and end hidden items with numeric +N.
//
// Live rows and semantic notices are drawn the same way as their desktop counterparts. Two rows
// carry live state rather than history, and both are drawn the way the desktop chat draws
// them. The block being written right now (`preview`) is revealed at a steady character rate instead
// of a delta at a time, through the SHARED pacing rule and frame loop (`features/workbench`
// reveal-pacing + useRevealedText) — see MAssistantBlock. A message written into a running turn that
// the model has not read yet (`pending`) is pinned below everything, the preview included, and says
// so with dimmed text alone: the same ink bubble, full opacity, no icon, badge or spinner.
import { Fragment, useEffect, useRef, useState } from 'react';
import { ChatMarkdown } from '@/features/workbench/ChatMarkdown';
import { useRevealedText } from '@/features/workbench/useRevealedText';
import { useToolCallOverflow } from '@/features/workbench/useToolCallOverflow';
import { ChatNotice } from '@/features/workbench/ChatNotice';
import { SubagentTranscriptDetail } from '@/features/workbench/SubagentTranscriptDetail';
import { useVocab } from '@/i18n';
import { assistantTurnCopyTargets, regenNoteIndexes, subagentModelLabel, type ChatRow } from '@/features/workbench/transcript-vm';
import { interactionView, emptyAskAnswers } from '@/features/workbench/interaction-vm';
import { toolChips } from '@/mobile/screens/mobile-session-vm';
import { MDrillHeader, MMoreButton, MComposer, MBottomSheet, MDot, MC, MONO } from '@/mobile/ui/kit';
import { MAskCard, MPlanCard, M_INT_COPY } from './MInteractionCards';
import { MDecisionCardGroup } from './MDecisionCards';
import { AttachmentGroup } from './MChatAttachments';
import { AssistantTurnCopyAction, longPressHandlers, MsgActionMenu } from './MChatMessageActions';
import {
  AttachMenu, BrowserChip, CommissionChip, ComposerAbove, ComposerLeading, ComposerTools, MobileSlashMenu,
} from './MChatComposerPresentation';
import { BrowserSheet, CommissionSheet, ContextUsageSheet, MoreMenu, ProfileSheet, SessionIdSheet } from './MChatSheets';
import type { ChatHeaderStatus } from './m-chat-vm';
import type { MChatEditCopy, MChatInteractions, MChatViewProps, MEditMode } from './MChatView.types';

export { BrowserSheet, CommissionSheet, ContextUsageSheet, MoreMenu, ProfileSheet, SessionIdSheet } from './MChatSheets';
export { AttachMenu } from './MChatComposerPresentation';
export { EditBar, MsgActionMenu } from './MChatMessageActions';
export type {
  BrowserSheetItem, CommissionSheetItem, MChatCopy, MChatEditCopy, MChatInteractions, MChatViewProps,
  MEditMode, MMsgMenu, MRejectBar,
} from './MChatView.types';

// ── 1b header — ‹ back · title + status line · ⋯ menu ─────────────────────────
interface MChatHeaderProps {
  title: string;
  status: ChatHeaderStatus;
  onBack: () => void;
  onMore: () => void;
}

export function MChatHeader(props: MChatHeaderProps): JSX.Element {
  return (
    <MDrillHeader onBack={props.onBack} trailing={<MMoreButton onClick={props.onMore} />}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {props.title}
        </div>
        <MChatStatusLine {...props} />
      </div>
    </MDrillHeader>
  );
}

function MChatStatusLine({ status }: MChatHeaderProps): JSX.Element {
  return (
    <div data-chat-status-line="true" style={{ display: 'flex', alignItems: 'center', gap: 8, font: `400 10px ${MONO}`, color: status.tone === 'waiting' ? MC.amberText : MC.muted, marginTop: 1 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: status.tone === 'waiting' ? MC.amber : status.running ? MC.run : 'var(--proto-line-3)', animation: status.running ? 'cxpulse 1.6s ease-in-out infinite' : undefined, flex: 'none' }} />
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{status.text}</span>
      </span>
    </div>
  );
}

// The ⋯ menu exposes the functional Session ID sheet only.
// ── collapsed/expandable tool-call row (scheme 1b L146; tap to expand) ─────────
const MOBILE_TOOL_GAP = 6;
const mobileToolChipStyle = {
  font: `400 10px ${MONO}`, background: 'var(--proto-card)',
  border: '1px solid var(--proto-line-2)', padding: '1px 6px', borderRadius: 4, flex: 'none',
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
    <div onClick={onExpand} style={{ display: 'flex', alignItems: 'center', gap: MOBILE_TOOL_GAP, fontSize: 11, color: 'var(--proto-muted-3)', flexWrap: 'nowrap', whiteSpace: 'nowrap', overflow: 'hidden', cursor: 'pointer' }}>
      <span style={{ fontSize: 8.5, flex: 'none' }}>▸</span>
      <span style={{ flex: 'none' }}>{count} {unit}</span>
      <span ref={containerRef} style={mobileToolStripStyle}>
        {chips.names.map((name, index) => <MobileToolChip key={index} name={name} />)}
        {chips.overflow > 0 ? <span style={{ flex: 'none' }}>+{chips.overflow}</span> : null}
        <span ref={measureRef} aria-hidden="true" style={mobileToolMeasureStyle}>
          {labels.map((name, index) => <MobileToolChip key={index} name={name} />)}
          <span style={{ flex: 'none' }}>+{calls.length}</span>
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
    <div style={{ background: 'var(--proto-rail)', border: '1px solid var(--proto-line-2)', borderRadius: 8, overflow: 'hidden' }}>
      <div onClick={onCollapse} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--proto-muted-3)', padding: '6px 11px', cursor: 'pointer' }}>
        <span style={{ fontSize: 8.5 }}>▾</span>
        <span>{count} {unit}</span>
      </div>
      {calls.map((call, index) => (
        <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5.5px 11px', borderTop: '1px solid var(--proto-line-soft)' }}>
          <span style={{ font: `600 9px ${MONO}`, color: 'var(--proto-muted)', background: 'var(--proto-gray)', padding: '1.5px 7px', borderRadius: 5, flex: 'none' }}>{call.kind}</span>
          <span style={{ font: `400 10.5px ${MONO}`, color: MC.body, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{call.input}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * One native subagent's work, folded away by default.
 *
 * Mobile renders a FLATTENED view — the subagent's tool calls as one collapsed run plus its prose —
 * rather than recursing through the row renderer the way the desktop block does. The mobile stream
 * is a single inline JSX map with no recursive entry point, and a flattened block carries the same
 * information at this width.
 */
function MSubagentRows({ rows, unit }: { rows: ChatRow[]; unit: string }): JSX.Element {
  const calls = rows.flatMap((row) => row.kind === 'tools' ? row.calls : []);
  const texts = rows.flatMap((row) => row.kind === 'assistant' && row.text ? [row.text] : []);
  return <>{calls.length > 0 && <ToolCallsRow count={calls.length} calls={calls} unit={unit} />}
    {texts.map((text, index) => <div key={index} style={{ fontSize: 12.5, lineHeight: 1.6,
      color: MC.body, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
      <ChatMarkdown text={text} />
    </div>)}</>;
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
    <div style={{ background: 'var(--proto-rail)', border: '1px solid var(--proto-line-2)', borderRadius: 8 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        role="button"
        aria-expanded={expanded}
        style={{ position: 'sticky', top: 0, zIndex: 1, display: 'flex', alignItems: 'center', gap: 7, padding: '6px 11px', fontSize: 11.5, color: MC.faint, background: 'var(--proto-rail)', minWidth: 0 }}
      >
        <MDot
          color={row.status === 'running' ? 'var(--proto-accent)' : 'var(--proto-success)'}
          pulse={row.status === 'running'}
        />
        <span style={{ font: `600 9px ${MONO}`, color: 'var(--proto-muted)', background: 'var(--proto-gray)', padding: '1.5px 7px', borderRadius: 5, flex: 'none' }}>
          {row.agentType || L.subagentFallbackLabel}
        </span>
        {row.model ? (
          <span style={{ font: `600 9px ${MONO}`, color: 'var(--proto-muted-3)', border: '1px solid var(--proto-line-2)', padding: '1.5px 7px', borderRadius: 5, flex: 'none' }}>
            {subagentModelLabel(row.model)}
          </span>
        ) : null}
        <span style={{ font: `400 11px ${MONO}`, color: MC.body, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{label}</span>
        <span style={{ font: `400 10px ${MONO}`, flex: 'none', marginLeft: 'auto' }}>{`${row.toolCount} ${unit}`}</span>
      </div>
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 11px 10px', borderTop: '1px solid var(--proto-line-soft)' }}>
          {row.prompt ? (
            <div>
              <div style={{ font: `600 9px ${MONO}`, color: MC.faint, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                {L.subagentPromptLabel}
              </div>
              <pre style={{ margin: 0, font: `400 10.5px/1.55 ${MONO}`, color: MC.body, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
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
  const color = v.tone === 'rejected' ? 'var(--proto-danger)' : v.tone === 'inactive' ? 'var(--proto-muted-3)' : MC.done;
  const icon = v.tone === 'rejected' ? '✗' : v.tone === 'inactive' ? '◌' : '✓';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px', background: 'var(--proto-card)', border: '1px solid var(--proto-line-2)', borderRadius: 10, opacity: v.tone === 'inactive' ? 0.6 : 0.75 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color, flexShrink: 0 }}>{icon} {v.label}</span>
      <span style={{ fontSize: 11.5, color: MC.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.text}</span>
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
        const canHold = !!editCopy && !!onLongPress && editingIdx == null && row.kind === 'user';
        const hold = canHold ? longPressHandlers((anchorTop) => onLongPress!(i, anchorTop)) : null;
        return (
        <Fragment key={row.kind === 'interaction' && row.detail ? `int-${row.detail.id}` : i}>
          {row.kind === 'divider' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, ...(dimmed ? { opacity: 0.35 } : {}) }}>
              <div style={{ flex: 1, height: 1, background: 'var(--proto-line)' }} />
              <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '.06em', color: MC.faint }}>{row.text}</div>
              <div style={{ flex: 1, height: 1, background: 'var(--proto-line)' }} />
            </div>
          )}
          {row.kind === 'user' && (
            <>
              {row.attachments && row.attachments.length > 0 && <AttachmentGroup attachments={row.attachments} />}
              <div style={{ alignSelf: 'flex-end', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, maxWidth: '82%', ...(dimmed ? { opacity: 0.35, pointerEvents: 'none' as const } : {}) }}>
                {/* 7b — the bubble being edited rings accent + 编辑中 badge */}
                {isEditingRow && editCopy && (
                  <span style={{ font: `600 9.5px ${MONO}`, color: MC.run, background: 'var(--proto-accent-bg)', padding: '2px 7px', borderRadius: 4 }}>{editCopy.editingBadge}</span>
                )}
                <div
                  {...(hold ?? {})}
                  data-msg-bubble={canHold ? i : undefined}
                  style={{
                    background: MC.ink,
                    // A message written into the running turn's backend that the model has not read
                    // yet dims its TEXT and nothing else — same bubble, full opacity, no icon, badge
                    // or spinner. The row is provisional, not disabled or failing, and any marker
                    // heavier than the ink would read as one. It clears the instant it is delivered.
                    color: row.pending ? MC.inkSolidFgDim : MC.inkSolidFg,
                    borderRadius: '16px 16px 4px 16px',
                    padding: '9px 13px',
                    fontSize: 13.5,
                    lineHeight: 1.55,
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'break-word',
                    wordBreak: 'break-word',
                    WebkitUserSelect: canHold ? 'none' : undefined,
                    userSelect: canHold ? 'none' : undefined,
                    WebkitTouchCallout: canHold ? 'none' : undefined,
                    ...(isEditingRow ? { boxShadow: `0 0 0 2px ${MC.canvas}, 0 0 0 3.5px ${MC.run}` } : {}),
                  } as React.CSSProperties}
                >
                  {row.text}
                </div>
                {/* 已编辑 note — tap opens the original-message sheet */}
                {editCopy && row.edited && !isEditingRow && (
                  <span
                    role="button"
                    onClick={onShowOriginal ? () => onShowOriginal(row.edited!) : undefined}
                    style={{ font: `400 9.5px ${MONO}`, color: MC.faint, cursor: 'pointer' }}
                  >
                    <span style={{ borderBottom: `1px dotted ${MC.faint}` }}>{editCopy.edited}</span>
                  </span>
                )}
              </div>
              {/* 7b — the 将被回退 badge opens the dimmed tail right after the edited bubble */}
              {isEditingRow && editCopy && editing && (
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <span style={{ font: `600 9px ${MONO}`, color: 'var(--m-amber-ink)', background: MC.amberBg, padding: '2px 7px', borderRadius: 4 }}>
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
              style={{ fontSize: 13.5, lineHeight: 1.65, color: MC.body, minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word', ...(dimmed ? { opacity: 0.35, pointerEvents: 'none' as const } : {}), WebkitUserSelect: canHold ? 'none' : undefined, userSelect: canHold ? 'none' : undefined, WebkitTouchCallout: canHold ? 'none' : undefined } as React.CSSProperties}
            >
              {/* 由编辑重新生成 — footnote atop the first regenerated reply after an edit */}
              {editCopy && regenIdx?.has(i) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, font: `400 9.5px ${MONO}`, color: MC.faint, marginBottom: 4 }}>
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
        font: `400 9.5px ${MONO}`,
        color: MC.faint,
        background: 'var(--proto-card)',
        border: '1px solid var(--proto-line-2)',
        padding: '3px 10px',
        borderRadius: 999,
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
      style={{ height: '100%', position: 'relative', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', background: MC.canvas }}
    >
      <MChatHeader
        title={props.title}
        status={props.status}
        onBack={props.onBack}
        onMore={props.onMoreToggle}
      />
      {/* Body region — a position:relative frame holding the scroll transcript + composer. The
          full-screen editor (2b) mounts as an absolute overlay of THIS region, so it covers the
          transcript + composer while leaving the header untouched. */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Plain-block scroll container (like the desktop MessageStream) with an inner flex-column
            content wrapper — keeps programmatic scrollTop stick-to-bottom reliable in mobile webviews.
            Isolate sticky headers so their z-index cannot escape over the composer or overlays. */}
        <div ref={scrollRef} onScroll={onScroll} onClick={onContentClick} style={{ flex: 1, minHeight: 0, overflow: 'auto', isolation: 'isolate', background: MC.canvas }}>
          <div ref={contentRef} style={{ padding: '14px 14px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
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
            <div style={{ height: 'calc(8px + env(safe-area-inset-bottom))', flex: 'none' }} />
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
        />
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
          <div style={{ font: `600 10px ${MONO}`, color: MC.muted, letterSpacing: '.05em', padding: '0 2px 8px' }}>{props.editCopy.original}</div>
          <div style={{ background: 'var(--proto-card)', border: `1px solid ${MC.hairline}`, borderRadius: 13, padding: '11px 13px', fontSize: 13, lineHeight: 1.6, color: MC.body, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', maxHeight: '50vh', overflow: 'auto' }}>
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
      {props.profileSheet && (
        <ProfileSheet items={props.profileSheet.items} copy={copy} onClose={props.profileSheet.onClose} onPick={props.profileSheet.onPick} />
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
