// input:  ChatRows, lazy subagent detail, extracted attachment/decision cards, notices, and edits
// output: Scroll-stable transcript with prompt cards, turn-tail actions, and message controls
// pos:    Desktop workbench message presentation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import type { ChatRow } from './transcript-vm';
import { ToolCallsRow } from './ToolCallsRow';
import { SubagentBlock } from './SubagentBlock';
import { SubagentTranscriptDetail } from './SubagentTranscriptDetail';
import { ChatMarkdown } from './ChatMarkdown';
import type { AttachmentMeta, AttachmentMeta as Attachment } from '@/features/attachments/types';
import { AgentFileGroup, AttachmentCard } from './MessageAttachmentCards';
import { interactionView, emptyDeskAsk, type DeskAskState } from './interaction-vm';
import type { InteractionActions } from './useInteractionActions';
import { DeskAskCard, DeskPlanCard, D_INT_COPY } from './InteractionCards';
import { DecisionCardGroup } from './DecisionCards';
import type { DecisionItem } from '@cortex-agent/ui-contract';
import { PlanReadOverlay } from './PlanReadOverlay';
import { rewindStats, regenNoteIndexes, messageTimeLabel, assistantTurnCopyTargets } from './transcript-vm';
import { useRevealedText } from './useRevealedText';
import { DebugDetailsModal, DebugInspectButton, type DebugDetail } from './DebugDetailsModal';
import { M_EDIT_COPY, MessageActions, EditBox, RewindNote, RewindTail, EditedBadge, RegenNote, type MEditCopy } from './MessageEdit';
import { ChatNotice } from './ChatNotice';

/** Readable prose column, and the gutter between it and the pane edge. The gutter doubles as the
 *  breathing room a pane-wide block keeps, so a wide table lines up with the column's own padding. */
const COLUMN_W = 756;
const GUTTER = 32;

/** Edit+rewind context passed from CenterChat (sessions.rewind). Absent → chat is read-only
 *  w.r.t. editing (the thread step chat), hover copy still works. */
export interface MessageEditCtx {
  /** Live turn on the session — editing is greyed out (运行中不可编辑). */
  running: boolean;
  /** A rewind mutation is in flight. */
  busy: boolean;
  onSubmit: (turnIndex: number, text: string) => void;
}

// Message stream — 1:1 from prototype.dc.html L131–357. The transcript body (divider / user bubble /
// tool-call row / assistant text) is driven by REAL data (task aba0): the `rows` are built from the
// real `sessions.transcript` query + live `session.message` stream by the pure transcript-vm. A
// reply still being written grows in place with no caret; a mid-turn message the model has not read
// yet trails the stream with dimmed text. Assistant text renders as Markdown.
// The stream sticks to the bottom while new content lands, but releases when the user scrolls up
// (and re-pins once they scroll back to the bottom).
//
// The row still being written (`preview`) is revealed at a steady character rate rather than a delta
// at a time — the deltas arrive about a line at a time, which reads as a staircase instead of as
// writing. The pacing rule is pure (`reveal-pacing`) and its frame loop is shared with the mobile
// chat (`useRevealedText`); the rAF state lives in the assistant block that draws it, so a per-frame
// update re-renders ONE row and never the transcript. Everything already in
// the buffer is on its way to the screen, so nothing is predicted: the drawn string is always a
// prefix of what arrived. Settling needs no special case — the paced text and the committed text
// share one component instance, so the row simply stops being a preview when the authoritative
// message lands (or the turn ends, or a rewind arrives) and is drawn whole on that render, with no
// remount that would replay the block's entry fade.

const mono = "'IBM Plex Mono',monospace";

function Divider({ text }: { text: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ flex: 1, height: 1, background: 'var(--proto-line-2)' }} />
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', color: 'var(--proto-faint)' }}>{text}</div>
      <div style={{ flex: 1, height: 1, background: 'var(--proto-line-2)' }} />
    </div>
  );
}

function UserBubble({ text, attachments, ts, edited, editCopy, onStartEdit, editDisabled, pending, debug }: {
  text: string;
  attachments?: AttachmentMeta[];
  ts?: string;
  edited?: { originalText: string; originalTs: string };
  /** Present → the sec-23 hover copy/edit affordances render. */
  editCopy?: MEditCopy;
  /** Present → the pill carries the edit button (rewind-capable rows only). */
  onStartEdit?: () => void;
  editDisabled?: boolean;
  /** Written to the backend but not yet read by the model. Only the TEXT dims — the bubble keeps
   *  its background and full opacity, and nothing else marks the state. The row is provisional, not
   *  disabled or failing, and an icon/spinner/label would read as either. */
  pending?: boolean;
  /** Present only when the server returned DEBUG-gated exact adapter input. */
  debug?: { agentMessage: string };
}): JSX.Element {
  const hasAttachments = attachments && attachments.length > 0;
  const [debugDetail, setDebugDetail] = useState<DebugDetail | null>(null);
  const timeLabel = messageTimeLabel(ts);
  return (
    <div
      className="group"
      style={{
        position: 'relative',
        alignSelf: 'flex-end',
        maxWidth: '75%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 6,
        animation: 'cxmsg .34s cubic-bezier(.22,1,.36,1) both',
      }}
    >
      {/* Attachments above the bubble */}
      {hasAttachments && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {attachments!.map((a, i) => (
            <AttachmentCard key={i} a={a} />
          ))}
        </div>
      )}
      {text && (
        <div style={{ position: 'relative', display: 'flex', justifyContent: 'flex-end', maxWidth: '100%' }}>
          <div
            style={{
              background: 'var(--proto-gray)',
              borderRadius: '14px 14px 4px 14px',
              padding: '9px 14px',
              fontSize: 13.5,
              lineHeight: 1.55,
              color: pending ? 'var(--proto-muted)' : 'var(--proto-ink)',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'break-word',
              wordBreak: 'break-word',
              minWidth: 0,
            }}
          >
            {text}
          </div>
        </div>
      )}
      {(timeLabel || (editCopy && (text || debug))) && (
        <div
          className="pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
          style={{ height: 26, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}
        >
          {timeLabel && (
            <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-faint)', whiteSpace: 'nowrap', flex: 'none' }}>
              {timeLabel}
            </span>
          )}
          {editCopy && (text || debug) && (
            <MessageActions
              text={text}
              copy={editCopy}
              showCopy={!!text}
              onEdit={text ? onStartEdit : undefined}
              editDisabled={editDisabled}
              extraAction={debug ? (
                <DebugInspectButton
                  className="!h-[26px] !min-w-[26px] !border-0 !bg-transparent !px-0 !shadow-none"
                  onClick={(event) => { event.stopPropagation(); setDebugDetail({ kind: 'user', agentMessage: debug.agentMessage }); }}
                />
              ) : undefined}
            />
          )}
        </div>
      )}
      <DebugDetailsModal detail={debugDetail} onClose={() => setDebugDetail(null)} />
      {/* 已编辑 badge + hover original card (sec-23 right column) */}
      {editCopy && edited && <EditedBadge edited={edited} ts={ts} copy={editCopy} />}
    </div>
  );
}

function TurnCopyAction({ text, copy }: { text?: string; copy?: MEditCopy }): JSX.Element | null {
  if (!text || !copy) return null;
  return (
    <div
      data-assistant-turn-copy="true"
      className="pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
      style={{ height: 26, marginTop: 4, display: 'flex', alignItems: 'center' }}
    >
      <MessageActions text={text} copy={copy} />
    </div>
  );
}

function AssistantBlock({ text, attachments, decisions, editCopy, copyText, regen, preview, streamKey }: {
  text: string;
  attachments?: Attachment[];
  /** Decisions announced with this row (send_decision) — cards hang under the text. */
  decisions?: DecisionItem[];
  /** Shared copy labels for regenerated notes and the optional whole-turn copy action. */
  editCopy?: MEditCopy;
  /** Present only on the final assistant row in a turn. */
  copyText?: string;
  /** True → the「由编辑重新生成」footnote renders atop this block. */
  regen?: boolean;
  /** True → this is the block being written right now, so its text is revealed at a steady rate. */
  preview?: boolean;
  /** Identity of the stream the preview belongs to (the session) — a change settles the reveal. */
  streamKey?: string;
}): JSX.Element {
  const hasAttachments = !!attachments && attachments.length > 0;
  const shown = useRevealedText(text, !!preview, streamKey);
  return (
    <div
      className="group"
      style={{ position: 'relative', animation: 'cxmsg .34s cubic-bezier(.22,1,.36,1) both', fontSize: 14, lineHeight: 1.65, color: 'var(--proto-ink-2)', minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word' }}
    >
      {editCopy && regen && <div style={{ marginBottom: 4 }}><RegenNote copy={editCopy} /></div>}
      {/* Token-level streaming carries NO caret here: the text visibly extends itself and the
          composer already reports the running turn, so a blinking block only adds noise. The
          mobile stream keeps its own caret (smaller viewport, no persistent status line). */}
      {shown.trim() && <ChatMarkdown text={shown} renderMath wideTables />}
      {hasAttachments && <AgentFileGroup attachments={attachments!} />}
      {!!decisions && decisions.length > 0 && <DecisionCardGroup decisions={decisions} sessionId={streamKey} />}
      <TurnCopyAction text={copyText} copy={editCopy} />
    </div>
  );
}

/** One-line summary row for resolved / expired / cancelled interactions (and legacy rows). */
function InteractionSummaryRow({ tone, label, text }: { tone: 'done' | 'rejected' | 'inactive'; label: string; text: string }): JSX.Element {
  const color = tone === 'rejected' ? 'var(--proto-danger)' : tone === 'inactive' ? 'var(--proto-muted-3)' : 'var(--proto-success)';
  const icon = tone === 'rejected' ? '✗' : tone === 'inactive' ? '◌' : '✓';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--proto-rail)', border: '1px solid var(--proto-line-2)', borderRadius: 10, opacity: tone === 'inactive' ? 0.6 : 0.85 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color, flexShrink: 0 }}>{icon} {label}</span>
      <span style={{ fontSize: 12, color: 'var(--proto-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
    </div>
  );
}

/** Interaction row — the transcript-inline card (scheme 13b/13c). Entity rows render the full
 *  desktop cards (pending actionable · resolved sealed in place); expired/cancelled + legacy rows
 *  render one-line summaries. The row owns the 13b answer state, the 13c 请求修改 expansion and
 *  the reading overlay (阅读 › / 查看计划 ›). */
export function InteractionRowCard({ row, actions }: {
  row: Extract<ChatRow, { kind: 'interaction' }>;
  actions?: InteractionActions;
}): JSX.Element {
  const lang = useLang();
  const copy = lang === 'zh' ? D_INT_COPY.zh : D_INT_COPY.en;
  const [askState, setAskState] = useState<DeskAskState>(emptyDeskAsk);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [readOpen, setReadOpen] = useState(false);
  const v = interactionView(row);

  if (v.kind === 'ask') {
    const m = v.model;
    return (
      <DeskAskCard
        model={m}
        state={askState}
        copy={copy}
        onState={setAskState}
        onSubmit={(answers) => actions?.answerQuestion(m.requestId, answers)}
        busy={!!actions?.busy}
      />
    );
  }
  if (v.kind === 'plan') {
    const m = v.model;
    return (
      <>
        <DeskPlanCard
          model={m}
          copy={copy}
          feedbackOpen={feedbackOpen}
          onFeedbackOpen={setFeedbackOpen}
          onApprove={() => actions?.approvePlan(m.requestId)}
          onReject={(fb) => {
            actions?.rejectPlan(m.requestId, fb);
            setFeedbackOpen(false);
          }}
          onOpenRead={() => setReadOpen(true)}
          busy={!!actions?.busy}
        />
        {readOpen && (
          <PlanReadOverlay
            model={m}
            copy={copy}
            lang={lang}
            onClose={() => setReadOpen(false)}
            onApprove={() => {
              actions?.approvePlan(m.requestId);
              setReadOpen(false);
            }}
            onRequestChanges={() => {
              setReadOpen(false);
              setFeedbackOpen(true);
            }}
          />
        )}
      </>
    );
  }
  return <InteractionSummaryRow tone={v.tone} label={v.label} text={v.text} />;
}

function Row({ row, interactionActions, editCopy, assistantCopyText, onStartEdit, editDisabled, regen, streamKey }: {
  row: ChatRow;
  interactionActions?: InteractionActions;
  editCopy?: MEditCopy;
  assistantCopyText?: string;
  onStartEdit?: () => void;
  editDisabled?: boolean;
  regen?: boolean;
  /** Identity of the live stream these rows belong to — see AssistantBlock. */
  streamKey?: string;
}): JSX.Element | null {
  switch (row.kind) {
    case 'divider':
      return <Divider text={row.text} />;
    case 'user':
      return <UserBubble text={row.text} attachments={row.attachments} ts={row.ts} edited={row.edited} editCopy={editCopy} onStartEdit={onStartEdit} editDisabled={editDisabled} pending={row.pending} debug={row.debug} />;
    case 'tools':
      return (
        <div className="group">
          <ToolCallsRow
            calls={row.calls.map((c) => ({ label: c.kind, kind: c.kind, input: c.input, ...(c.debug ? { debug: c.debug } : {}) }))}
            sessionId={streamKey}
          />
          <TurnCopyAction text={assistantCopyText} copy={editCopy} />
        </div>
      );
    case 'assistant':
      return <AssistantBlock text={row.text} attachments={row.attachments} decisions={row.decisions} editCopy={editCopy} copyText={assistantCopyText} regen={regen} preview={row.preview} streamKey={streamKey} />;
    case 'notice':
      return (
        <div className="group">
          <ChatNotice
            level={row.level} text={row.text} authAction={row.authAction}
            noticeAction={row.noticeAction}
            onNoticeAction={interactionActions?.cancelResume}
            noticeActionDone={interactionActions?.resumeCancelled}
          />
          <TurnCopyAction text={assistantCopyText} copy={editCopy} />
        </div>
      );
    case 'interaction':
      return (
        <div className="group" style={{ display: 'flex', flexDirection: 'column' }}>
          <InteractionRowCard row={row} actions={interactionActions} />
          <TurnCopyAction text={assistantCopyText} copy={editCopy} />
        </div>
      );
    case 'subagent':
      return (
        <div className="group">
          <SubagentBlock
            agentType={row.agentType}
            description={row.description}
            prompt={row.prompt}
            model={row.model}
            status={row.status}
            toolCount={row.toolCount}
          >
            {row.detailMode === 'lazy' && row.hasDetails && streamKey ? (
              <SubagentTranscriptDetail
                sessionId={streamKey}
                subagentId={row.id}
                fallbackRows={row.children}
                render={(detailRows) => (
                  <ChatRows rows={detailRows} interactionActions={interactionActions} streamKey={streamKey} turnCopy={false} />
                )}
              />
            ) : (
              <ChatRows rows={row.children} interactionActions={interactionActions} streamKey={streamKey} turnCopy={false} />
            )}
          </SubagentBlock>
          <TurnCopyAction text={assistantCopyText} copy={editCopy} />
        </div>
      );
    default:
      return null;
  }
}

/** Presentational transcript column — the ordered chat rows (divider / user / tools / assistant) laid
 *  out vertically. Framework-free of the scroll/stick behavior so it can be embedded wherever a
 *  transcript needs rendering (the workbench center chat, the thread-detail step chat). Owns the
 *  sec-23 message-edit state when an `edit` context is passed (the workbench center chat): the edited
 *  bubble becomes an in-place EditBox, later rows dim under a「将被回退」badge, and submit fires
 *  the rewind. */
export function ChatRows({ rows, interactionActions, edit, streamKey, turnCopy = true }: { rows: ChatRow[]; interactionActions?: InteractionActions; edit?: MessageEditCtx; streamKey?: string; turnCopy?: boolean }): JSX.Element {
  const lang = useLang();
  const editCopy = lang === 'zh' ? M_EDIT_COPY.zh : M_EDIT_COPY.en;
  // The row currently being edited (a user row with a turnIndex). Reset when the row set changes
  // shape enough that the anchor no longer matches (guard inside the render below).
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const regenIdx = regenNoteIndexes(rows);
  const assistantCopies = turnCopy ? assistantTurnCopyTargets(rows) : new Map<number, string>();

  const editingRow = editingIdx != null ? rows[editingIdx] : null;
  const editingValid = !!edit && !!editingRow && editingRow.kind === 'user' && editingRow.turnIndex !== undefined;
  const stats = editingValid ? rewindStats(rows, editingIdx!) : null;

  const rowKey = (row: ChatRow, i: number): string | number => {
    if (row.kind === 'interaction' && row.detail) return `int-${row.detail.id}`;
    // Keyed by identity so the block keeps its expanded/collapsed state while it is still growing.
    if (row.kind === 'subagent') return `sub-${row.id}`;
    return i;
  };

  if (editingValid) {
    const er = editingRow as Extract<ChatRow, { kind: 'user' }>;
    const before = rows.slice(0, editingIdx!);
    const after = rows.slice(editingIdx! + 1);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {before.map((row, i) => (
          <Row key={rowKey(row, i)} row={row} interactionActions={interactionActions} streamKey={streamKey} />
        ))}
        <EditBox
          initialText={er.text}
          copy={editCopy}
          busy={edit!.busy}
          onCancel={() => setEditingIdx(null)}
          onSubmit={(text) => {
            edit!.onSubmit(er.turnIndex!, text);
            setEditingIdx(null);
          }}
        />
        {stats && <RewindNote replies={stats.replies} toolCalls={stats.toolCalls} copy={editCopy} />}
        {after.length > 0 && (
          <RewindTail copy={editCopy}>
            {after.map((row, i) => (
              <Row key={rowKey(row, editingIdx! + 1 + i)} row={row} interactionActions={interactionActions} streamKey={streamKey} />
            ))}
          </RewindTail>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {rows.map((row, i) => (
        <Row
          key={rowKey(row, i)}
          row={row}
          interactionActions={interactionActions}
          editCopy={editCopy}
          assistantCopyText={assistantCopies.get(i)}
          regen={regenIdx.has(i)}
          onStartEdit={edit && row.kind === 'user' && row.turnIndex !== undefined ? () => setEditingIdx(i) : undefined}
          editDisabled={edit?.running || edit?.busy}
          streamKey={streamKey}
        />
      ))}
    </div>
  );
}

export function MessageStream({ rows, loading, inlineThreadCard, interactionActions, edit, streamKey }: { rows: ChatRow[]; loading: boolean; inlineThreadCard?: React.ReactNode; interactionActions?: InteractionActions; edit?: MessageEditCtx; streamKey?: string }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Whether the view is currently pinned to the bottom. Starts pinned; a user scroll-up releases it,
  // scrolling back to the bottom re-pins it.
  const stickRef = useRef(true);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distanceFromBottom < 40;
  };

  // After every content change, keep the view pinned to the bottom IF the user hasn't scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [rows, loading]);

  // …and keep it pinned while the content GROWS between row changes. The streamed reply is revealed
  // character by character, so the block gets taller many times per row change; without this the
  // line being written slides under the bottom edge (measured: up to one line) and snaps back only
  // when the next delta arrives, which reads as a twitch under otherwise smooth text. Observing the
  // content box catches every cause of growth (the reveal, a late-loading image, markdown reflow)
  // and writes scrollTop directly — no React state, so it costs no render.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // Publish the pane's usable width so a block that should not obey the prose column can break out
  // of it (today: tables — see ChatMarkdown's TableBlock). The column is centred, so a block that
  // takes this width and pulls back half the difference lands centred on the pane. Written straight
  // to the node rather than through state: a pane resize must not re-render the whole transcript.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const publish = (): void => {
      el.style.setProperty('--chat-bleed-w', `${Math.max(0, el.clientWidth - GUTTER * 2)}px`);
    };
    publish();
    if (typeof ResizeObserver === 'undefined') return;
    // Content-box observation, so the shrink when the vertical scrollbar appears counts too.
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
      <div ref={contentRef} style={{ width: '100%', maxWidth: COLUMN_W, margin: '0 auto', padding: `22px ${GUTTER}px 12px` }}>
        <ChatRows rows={rows} interactionActions={interactionActions} edit={edit} streamKey={streamKey} />
        {inlineThreadCard && <div style={{ marginTop: 16 }}>{inlineThreadCard}</div>}
      </div>
    </div>
  );
}
