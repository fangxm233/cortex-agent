import { ChatMediaProvider } from '@/features/media/ChatMediaProvider';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmt, useVocab } from '@/i18n';
import type { ChatRow } from './transcript-vm';
import { SystemHintRow, ThinkingRow } from './HintRow';
import { ChatNavRail } from './ChatNavRail';
import { buildNavMarks, sameNavRows, visibleNavRows } from './chat-nav';
import { ToolCallsRow } from './ToolCallsRow';
import { SubagentBlock } from './SubagentBlock';
import { SubagentTranscriptDetail } from './SubagentTranscriptDetail';
import { ChatMarkdown } from '@/design/ChatMarkdown';
import type { AttachmentMeta, AttachmentMeta as Attachment } from '@/features/attachments/types';
import { AgentFileGroup, AttachmentCard } from './MessageAttachmentCards';
import { interactionView, emptyDeskAsk, type DeskAskState } from '@/features/session/interaction/interaction-vm';
import type { InteractionActions } from '@/features/session/interaction/useInteractionActions';
import { DeskAskCard, DeskPlanCard } from '@/features/session/interaction/InteractionCards';
import { DecisionList } from '@/features/session/interaction/DecisionRows';
import type { DecisionItem } from '@cortex-agent/ui-contract';
import { PlanReadOverlay } from '@/features/session/interaction/PlanReadOverlay';
import { rewindStats, regenNoteIndexes, messageTimeLabel, assistantTurnCopyTargets, liveToolsIndex, systemOriginDisplay, systemOriginLabel } from './transcript-vm';
import { useRevealedText } from './useRevealedText';
import { useNarrationHandoff } from './narration-handoff';
import { useEntryAnimation } from '@/design/Collapse';
import { DebugDetailsModal, DebugInspectButton, type DebugDetail } from './DebugDetailsModal';
import { MessageActions, EditBox, RewindNote, RewindTail, EditedBadge, RegenNote } from './MessageEdit';
import { ChatNotice } from './ChatNotice';
import { useTranscriptWindow } from './useTranscriptWindow';
import { useStickToBottom } from './useStickToBottom';
import { useTeamRowSlot } from './team-row-slot';
import { useBoardRowSlot } from './board-row-slot';
import { EventIcon, EventRow } from './EventRow';
import { SessionStateLine, WaitpointRow, WorkLog } from './WorkLog';
import { copyHosts, itemIndexes, layoutTurns, type TurnItem } from './turn-layout';

/** Readable prose column, and the gutter between it and the pane edge. The gutter doubles as the
 *  breathing room a pane-wide block keeps, so a wide table lines up with the column's own padding. */
const COLUMN_W = 760;
const GUTTER = 32;

/** Where a jump parks its target — the column's own top padding, so the message lands where a fresh
 *  screen of transcript would start. */
const JUMP_MARGIN = 22;

/** Edit+rewind context passed from CenterChat (sessions.rewind). Absent → chat is read-only
 *  w.r.t. editing (e.g. a nested subagent transcript), hover copy still works. */
export interface MessageEditCtx {
  /** Live turn on the session — editing is greyed out (运行中不可编辑). */
  running: boolean;
  /** A rewind mutation is in flight. */
  busy: boolean;
  onSubmit: (turnIndex: number, text: string) => Promise<unknown>;
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
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', color: 'var(--proto-muted)' }}>{text}</div>
      <div style={{ flex: 1, height: 1, background: 'var(--proto-line-2)' }} />
    </div>
  );
}

function UserBubble({ text, attachments, ts, edited, actions = false, onStartEdit, editDisabled, pending, debug, anchor, label }: {
  text: string;
  /** Who sent it when it was not the human at this keyboard (a lead session, in team mode). */
  label?: string;
  attachments?: AttachmentMeta[];
  ts?: string;
  /** Row index this bubble sits at, published to the DOM so the nav rail can scroll back to it.
   *  Absent in nested (subagent) transcripts, which have no rail. */
  anchor?: number;
  edited?: { originalText: string; originalTs: string };
  /** True → the sec-23 hover copy/edit affordances and the edited badge render. */
  actions?: boolean;
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
      data-chat-anchor={anchor}
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
      {label && (
        <span data-bubble-label="" style={{ font: `600 11px ${mono}`, letterSpacing: '.04em', color: 'var(--proto-muted)' }}>
          {label}
        </span>
      )}
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
              // Raised glass on the transcript, NOT a filter: this row scrolls, and blurring a
              // scrolling surface re-reads the backdrop on every frame. The hairline is a shadow
              // ring rather than a border so the bubble keeps its exact size.
              background: 'var(--glass-2)',
              boxShadow: 'var(--shadow-card-soft), 0 0 0 1px var(--proto-line)',
              borderRadius: 'var(--r-float) var(--r-float) var(--r-chip) var(--r-float)',
              padding: '10px 14px',
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
      {(timeLabel || (actions && (text || debug))) && (
        <div
          className="pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
          style={{ height: 26, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}
        >
          {timeLabel && (
            <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)', whiteSpace: 'nowrap', flex: 'none' }}>
              {timeLabel}
            </span>
          )}
          {actions && (text || debug) && (
            <MessageActions
              text={text}
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
      {actions && edited && <EditedBadge edited={edited} ts={ts} />}
    </div>
  );
}

function TurnCopyAction({ text }: { text?: string }): JSX.Element | null {
  if (!text) return null;
  return (
    <div
      data-assistant-turn-copy="true"
      className="pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
      style={{ height: 26, marginTop: 4, display: 'flex', alignItems: 'center' }}
    >
      <MessageActions text={text} />
    </div>
  );
}

function AssistantBlock({ text, attachments, decisions, copyText, regen, preview, streamKey, ts, narration = false }: {
  text: string;
  /** A working note inside a turn's open work log: a step quieter than the answer. */
  narration?: boolean;
  attachments?: Attachment[];
  /** Decisions announced with this row (send_decision) — cards hang under the text. */
  decisions?: DecisionItem[];
  /** Present only on the final assistant row in a turn. */
  copyText?: string;
  /** True → the「由编辑重新生成」footnote renders atop this block. */
  regen?: boolean;
  /** True → this is the block being written right now, so its text is revealed at a steady rate. */
  preview?: boolean;
  /** Identity of the stream the preview belongs to (the session) — a change settles the reveal. */
  streamKey?: string;
  ts?: string;
}): JSX.Element {
  const hasAttachments = !!attachments && attachments.length > 0;
  const shown = useRevealedText(text, !!preview, streamKey);
  const ref = useRef<HTMLDivElement>(null);
  const entry = useEntryAnimation('cxmsg .34s cubic-bezier(.22,1,.36,1) both');
  useNarrationHandoff(ref, text, streamKey, narration);
  return (
    <div
      ref={ref}
      className="group"
      data-narration={narration ? 'true' : undefined}
      style={{
        position: 'relative', animation: entry,
        fontSize: narration ? 14 : 14.5, lineHeight: narration ? 1.7 : 1.75, color: narration ? 'var(--proto-ink-3)' : 'var(--proto-ink-2)',
        ...(narration ? { margin: '5px 0' } : {}),
        minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word',
      }}
    >
      {regen && <div style={{ marginBottom: 4 }}><RegenNote /></div>}
      {/* Token-level streaming carries NO caret here: the text visibly extends itself and the
          composer already reports the running turn, so a blinking block only adds noise. The
          mobile stream keeps its own caret (smaller viewport, no persistent status line). */}
      {shown.trim() && <ChatMediaProvider sessionId={streamKey} ts={ts}><ChatMarkdown text={shown} renderMath wideTables /></ChatMediaProvider>}
      {hasAttachments && <AgentFileGroup attachments={attachments!} />}
      {!!decisions && decisions.length > 0 && <DecisionList decisions={decisions} sessionId={streamKey} />}
      <TurnCopyAction text={copyText} />
    </div>
  );
}

/** One-line summary row for expired / cancelled interactions (and legacy rows). */
function InteractionSummaryRow({ tone, label, text }: { tone: 'done' | 'rejected' | 'inactive'; label: string; text: string }): JSX.Element {
  const color = tone === 'rejected' ? 'var(--proto-danger)' : tone === 'inactive' ? undefined : 'var(--proto-success)';
  const icon = tone === 'rejected' ? 'cross' : tone === 'inactive' ? 'circle' : 'check';
  return <EventRow icon={<EventIcon name={icon} color={color} />} label={label} summary={text} attrs={{ 'data-interaction-summary': tone }} />;
}

/** A question the reader has answered: one line that opens to the questions and answers. */
function SealedAskRow({ children, count, time }: { children: JSX.Element; count: number; time: string | null }): JSX.Element {
  const copy = useVocab();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <EventRow icon={<EventIcon name={open ? 'chevron' : 'check'} open={open} color={open ? undefined : 'var(--proto-success)'} />}
        label={copy.ixAnswered} summary={count === 1 ? copy.chatAskAnsweredOne : fmt(copy.chatAskAnsweredMany, { n: count })}
        meta={time} expanded={open} onClick={() => setOpen((v) => !v)} attrs={{ 'data-interaction-sealed': 'ask' }} />
      {open && children}
    </div>
  );
}

/** A plan the reader has settled: one line, its title, and the way back into the plan. A rejected
 *  plan keeps the reader's feedback under it — those are the reader's own words. */
function SealedPlanRow({ approved, title, time, feedback, onOpen }: {
  approved: boolean; title: string; time: string | null; feedback: string | null; onOpen: () => void;
}): JSX.Element {
  const copy = useVocab();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <EventRow icon={<EventIcon name={approved ? 'check' : 'cross'} color={approved ? 'var(--proto-success)' : 'var(--proto-danger)'} />}
        label={approved ? copy.chatPlanApproved : copy.chatPlanRejected} summary={title}
        meta={<>{time}<span style={{ color: 'var(--proto-accent)', fontWeight: 550 }}>{copy.chatPlanView}</span></>}
        onClick={onOpen} attrs={{ 'data-interaction-sealed': approved ? 'plan-approved' : 'plan-rejected' }} />
      {!approved && feedback && (
        <div style={{ alignSelf: 'flex-end', maxWidth: '75%', background: 'var(--glass-2)', boxShadow: '0 0 0 1px var(--proto-line)', borderRadius: 'var(--r-float) var(--r-float) var(--r-chip) var(--r-float)', padding: '9px 14px', fontSize: 13.5, lineHeight: 1.55, color: 'var(--proto-ink)', whiteSpace: 'pre-wrap' }}>
          {feedback}
        </div>
      )}
    </div>
  );
}

/** Interaction row — the transcript-inline card (scheme 13b/13c). A pending question or plan is the
 *  full actionable card; once settled it folds to one line (an answered question opens back to its
 *  answers, a settled plan opens the reader); expired/cancelled + legacy rows are one-line
 *  summaries. The row owns the 13b answer state, the 13c 请求修改 expansion and the reading overlay. */
export function InteractionRowCard({ row, actions }: {
  row: Extract<ChatRow, { kind: 'interaction' }>;
  actions?: InteractionActions;
}): JSX.Element {
  const copy = useVocab();
  const [askState, setAskState] = useState<DeskAskState>(emptyDeskAsk);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [readOpen, setReadOpen] = useState(false);
  const v = interactionView(row, copy);

  if (v.kind === 'ask') {
    const m = v.model;
    const card = (
      <DeskAskCard
        model={m}
        state={askState}
        copy={copy}
        onState={setAskState}
        onSubmit={(answers) => actions?.answerQuestion(m.requestId, answers)}
        busy={!!actions?.busy}
      />
    );
    return m.status === 'pending' ? card : <SealedAskRow count={m.questions.length} time={m.timeLabel}>{card}</SealedAskRow>;
  }
  if (v.kind === 'plan') {
    const m = v.model;
    const settled = m.status === 'approved' || m.status === 'rejected';
    return (
      <>
        {settled ? (
          <SealedPlanRow approved={m.status === 'approved'} title={m.title} time={m.timeLabel} feedback={m.feedback}
            onOpen={() => setReadOpen(true)} />
        ) : (
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
        )}
        {readOpen && (
          <PlanReadOverlay
            model={m}
            copy={copy}
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

function Row({ row, interactionActions, actions = false, assistantCopyText, onStartEdit, editDisabled, regen, streamKey, anchor, inWork = false, background = false, liveTools = false }: {
  row: ChatRow;
  /** A tool run that is what the agent is doing right now (see liveToolsIndex). */
  liveTools?: boolean;
  /** Drawn inside a turn's open work log (see WorkLog): working notes read a step quieter. */
  inWork?: boolean;
  /** A subagent still running after its turn ended. */
  background?: boolean;
  interactionActions?: InteractionActions;
  /** True → user bubbles carry their copy/edit affordances (off for the rows around an open edit). */
  actions?: boolean;
  assistantCopyText?: string;
  onStartEdit?: () => void;
  editDisabled?: boolean;
  regen?: boolean;
  /** Identity of the live stream these rows belong to — see AssistantBlock. */
  streamKey?: string;
  /** Nav-rail anchor for a user row — see UserBubble. */
  anchor?: number;
}): JSX.Element | null {
  const L = useVocab();
  const team = useTeamRowSlot();
  const board = useBoardRowSlot();
  switch (row.kind) {
    case 'board-action':
      // Drawn by the board feature (it knows the board's live state and opens it); see board-row-slot.
      if (!board) return null;
      return (
        <div className="group" data-row={row.kind}>
          {board.row(row)}
          <TurnCopyAction text={assistantCopyText} />
        </div>
      );
    case 'team-action':
    case 'team-updates':
      // Drawn by the team feature (it knows each worker's live status); see team-row-slot.
      if (!team) return null;
      return (
        <div className="group" data-row={row.kind}>
          {team.row(row)}
          <TurnCopyAction text={assistantCopyText} />
        </div>
      );
    case 'divider':
      return <Divider text={row.text} />;
    case 'thinking':
      return <ThinkingRow text={row.text} preview={row.preview} />;
    case 'user':
      if (row.systemOrigin && systemOriginDisplay(row.systemOrigin) === 'bubble') {
        // A lead's message to its worker: the bubble it is, labelled with its sender; copyable but
        // not editable — there is no human turn here to rewind to.
        return <UserBubble text={row.text} attachments={row.attachments} ts={row.ts} actions={actions} pending={row.pending} debug={row.debug} label={systemOriginLabel(row.systemOrigin, L)} />;
      }
      if (row.systemOrigin) {
        // No affordance of its own (see SystemHintRow) — but it can be the last row of a running
        // turn, and the whole-turn copy action belongs under the last row, not above the hints.
        return (
          <div className="group">
            <SystemHintRow origin={row.systemOrigin} text={row.text} ts={row.ts} pending={row.pending} debug={row.debug}
              expandable={systemOriginDisplay(row.systemOrigin) === 'expandable'} />
            <TurnCopyAction text={assistantCopyText} />
          </div>
        );
      }
      return <UserBubble text={row.text} attachments={row.attachments} ts={row.ts} edited={row.edited} actions={actions} onStartEdit={onStartEdit} editDisabled={editDisabled} pending={row.pending} debug={row.debug} anchor={anchor} />;
    case 'tools':
      return (
        <div className="group" data-row="tools">
          <ToolCallsRow
            calls={row.calls}
            sessionId={streamKey}
            live={liveTools}
          />
          <TurnCopyAction text={assistantCopyText} />
        </div>
      );
    case 'assistant':
      return <AssistantBlock text={row.text} attachments={row.attachments} decisions={row.decisions} copyText={assistantCopyText} regen={regen} preview={row.preview} streamKey={streamKey} ts={row.ts} narration={inWork} />;
    case 'waitpoint':
      return (
        <div className="group" data-row={row.kind}>
          <WaitpointRow wait={row.wait} />
          <TurnCopyAction text={assistantCopyText} />
        </div>
      );
    case 'notice':
      return (
        <div className="group">
          <ChatNotice
            level={row.level} text={row.text} authAction={row.authAction}
            noticeAction={row.noticeAction}
            onNoticeAction={interactionActions?.cancelResume}
            noticeActionDone={interactionActions?.resumeCancelled}
          />
          <TurnCopyAction text={assistantCopyText} />
        </div>
      );
    case 'interaction':
      return (
        <div className="group" style={{ display: 'flex', flexDirection: 'column' }}>
          <InteractionRowCard row={row} actions={interactionActions} />
          <TurnCopyAction text={assistantCopyText} />
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
            background={background}
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
          <TurnCopyAction text={assistantCopyText} />
        </div>
      );
    default:
      return null;
  }
}

/** Space above an item in a laid-out stream: a new turn stands apart, the rows of one turn sit close. */
function itemGap(item: TurnItem, prev: TurnItem | undefined, rows: ChatRow[]): number {
  if (!prev) return 0;
  if (item.kind === 'row' && rows[item.index].kind === 'divider') return 28;
  if (prev.kind === 'row' && rows[prev.index].kind === 'divider') return 20;
  return item.segment !== prev.segment ? 30 : 8;
}

/** Presentational transcript column — the ordered chat rows (divider / user / tools / assistant) laid
 *  out vertically. Framework-free of the scroll/stick behavior so it can be embedded wherever a
 *  transcript needs rendering (the workbench center chat, nested subagent transcripts). With `group`
 *  (the top-level chat) the rows are laid out as turns — work folded into one line, the answer, what
 *  the turn produced (see turn-layout); without it they stand in a flat list, as a nested subagent
 *  transcript does. Owns the sec-23 message-edit state when an `edit` context is passed (the
 *  workbench center chat): the edited bubble becomes an in-place EditBox, later rows dim under a
 *  「将被回退」badge, and submit fires the rewind. */
export function ChatRows({ rows, interactionActions, edit, streamKey, turnCopy = true, anchors = false, start = 0, group = false, live = false }: { rows: ChatRow[]; interactionActions?: InteractionActions; edit?: MessageEditCtx; streamKey?: string; turnCopy?: boolean;
  /** True → user rows publish their index as a `data-chat-anchor`, which is what the nav rail
   *  scrolls to. Only the top-level workbench transcript sets it: a nested subagent transcript
   *  renders through this same component and its rows are not session-level destinations. */
  anchors?: boolean;
  /** First row to mount (see useTranscriptWindow). Rows keep their index into `rows` either way. */
  start?: number;
  /** Lay the rows out as turns (the top-level chat). */
  group?: boolean;
  /** The foreground turn is running: its work stays open and its trailing text is the answer so far. */
  live?: boolean }): JSX.Element {
  // The row currently being edited (a user row with a turnIndex). Reset when the row set changes
  // shape enough that the anchor no longer matches (guard inside the render below).
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const regenIdx = regenNoteIndexes(rows);
  const items = useMemo(() => (group ? layoutTurns(rows, { live }) : null), [rows, group, live]);
  const copies = useMemo(() => {
    if (!turnCopy) return new Map<number, string>();
    const targets = assistantTurnCopyTargets(rows, { live });
    return items ? copyHosts(items, targets, rows) : targets;
  }, [rows, items, turnCopy, live]);
  const liveTools = useMemo(() => liveToolsIndex(rows, live), [rows, live]);

  const editingRow = editingIdx != null ? rows[editingIdx] : null;
  const editingValid = !!edit && !!editingRow && editingRow.kind === 'user' && !editingRow.systemOrigin && editingRow.turnIndex !== undefined;

  const rowKey = (row: ChatRow, i: number): string | number => {
    if (row.kind === 'interaction' && row.detail) return `int-${row.detail.id}`;
    // Keyed by identity so the block keeps its expanded/collapsed state while it is still growing.
    if (row.kind === 'subagent') return `sub-${row.id}`;
    // Keyed by its first update so an open card stays open while the run grows.
    if (row.kind === 'team-updates') return `team-${row.id}`;
    return i;
  };

  // Anchors mirror the nav rail's marks, which skip system-authored rows — see buildNavMarks.
  const anchorOf = (row: ChatRow, i: number): number | undefined => (anchors && row.kind === 'user' && !row.systemOrigin ? i : undefined);
  const rowEl = (i: number, withActions: boolean, opts: { copyText?: string; inWork?: boolean; background?: boolean } = {}): JSX.Element => {
    const row = rows[i];
    return (
      <Row
        key={rowKey(row, i)}
        row={row}
        interactionActions={interactionActions}
        actions={withActions}
        assistantCopyText={opts.copyText}
        regen={withActions && regenIdx.has(i)}
        onStartEdit={withActions && edit && row.kind === 'user' && !row.systemOrigin && row.turnIndex !== undefined ? () => setEditingIdx(i) : undefined}
        editDisabled={edit?.running || edit?.busy}
        streamKey={streamKey}
        anchor={anchorOf(row, i)}
        inWork={opts.inWork}
        background={opts.background}
        liveTools={i === liveTools}
      />
    );
  };

  /** The rows from `from` up to (not including) `to`: laid out as turns when grouping, else flat. */
  const range = (from: number, to: number, withActions: boolean): JSX.Element[] => {
    if (!items) {
      return rows.slice(from, to).map((_, j) => rowEl(from + j, withActions, { copyText: withActions ? copies.get(from + j) : undefined }));
    }
    const out: JSX.Element[] = [];
    let prev: TurnItem | undefined;
    items.forEach((item, k) => {
      const indexes = itemIndexes(item);
      if (indexes[indexes.length - 1] < from || indexes[0] >= to) return;
      const gap = itemGap(item, prev, rows);
      if (gap) out.push(<div key={`gap-${k}`} aria-hidden="true" style={{ height: gap, flex: 'none' }} />);
      prev = item;
      const copyText = withActions ? copies.get(k) : undefined;
      if (item.kind === 'row') {
        const row = rows[item.index];
        out.push(rowEl(item.index, withActions, { copyText, background: item.role === 'pinned' && row.kind === 'subagent' }));
        return;
      }
      out.push(
        <div key={item.key} className="group">
          <WorkLog stats={item.stats} live={item.live} footer={<TurnCopyAction text={copyText} />}>
            {item.indexes.map((i) => rowEl(i, withActions, { inWork: true }))}
          </WorkLog>
        </div>,
      );
    });
    return out;
  };

  if (editingValid) {
    return (
      <EditingRows rows={rows} editingIdx={editingIdx!} from={Math.min(start, editingIdx!)} edit={edit!}
        range={(from, to) => range(from, to ?? rows.length, false)} gap={items ? 0 : 18} onDone={() => setEditingIdx(null)} />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: items ? 0 : 18 }}>
      {range(start, rows.length, true)}
    </div>
  );
}

/** sec-23 edit mode: the edited bubble becomes an in-place EditBox and the rows after it dim under
 *  the「将被回退」badge. */
function EditingRows({ rows, editingIdx, from, edit, range, gap, onDone }: {
  rows: ChatRow[];
  editingIdx: number;
  from: number;
  edit: MessageEditCtx;
  range: (from: number, to?: number) => JSX.Element[];
  gap: number;
  onDone: () => void;
}): JSX.Element {
  const er = rows[editingIdx] as Extract<ChatRow, { kind: 'user' }>;
  const stats = rewindStats(rows, editingIdx);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {from < editingIdx && <div style={{ display: 'flex', flexDirection: 'column', gap }}>{range(from, editingIdx)}</div>}
      <EditBox
        initialText={er.text}
        busy={edit.busy}
        onCancel={onDone}
        onSubmit={(text) => {
          void edit.onSubmit(er.turnIndex!, text).then(onDone, () => {});
        }}
      />
      {stats && <RewindNote replies={stats.replies} toolCalls={stats.toolCalls} />}
      {editingIdx + 1 < rows.length && <RewindTail>{range(editingIdx + 1)}</RewindTail>}
    </div>
  );
}

function scrollToAnchor(el: HTMLElement | null, row: number): void {
  const node = el?.querySelector<HTMLElement>(`[data-chat-anchor="${row}"]`);
  if (!el || !node) return;
  const top = el.scrollTop + (node.getBoundingClientRect().top - el.getBoundingClientRect().top) - JUMP_MARGIN;
  if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: 'smooth' });
  else el.scrollTop = top;
}

export function MessageStream({ rows, loading, interactionActions, edit, streamKey, live = false }: { rows: ChatRow[]; loading: boolean; interactionActions?: InteractionActions; edit?: MessageEditCtx; streamKey?: string;
  /** The foreground turn is running (not merely held open by background work). */
  live?: boolean }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // The session's own table of contents — one mark per prompt (see ChatNavRail).
  const marks = useMemo(() => buildNavMarks(rows), [rows]);
  const [activeRows, setActiveRows] = useState<number[]>([]);
  const syncRaf = useRef(0);

  // Which turns the viewport is showing. Measured from live rects rather than stored offsets: the
  // transcript's rows change height constantly (streamed text, images, expanding tool rows), so any
  // cached geometry would be wrong by the next frame. Coalesced to one read per frame.
  const syncActive = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    const base = el.getBoundingClientRect().top;
    const tops = Array.from(el.querySelectorAll<HTMLElement>('[data-chat-anchor]')).map((node) => ({
      row: Number(node.dataset.chatAnchor),
      top: node.getBoundingClientRect().top - base,
    }));
    const next = visibleNavRows(tops, el.clientHeight);
    setActiveRows((prev) => (sameNavRows(prev, next) ? prev : next));
  }, []);

  const scheduleSync = useCallback((): void => {
    if (typeof requestAnimationFrame === 'undefined') {
      syncActive();
      return;
    }
    if (syncRaf.current) return;
    syncRaf.current = requestAnimationFrame(() => {
      syncRaf.current = 0;
      syncActive();
    });
  }, [syncActive]);

  // Only the tail of a long transcript is mounted; scrolling toward the top mounts more.
  const win = useTranscriptWindow({ total: rows.length, streamKey, settled: !loading, scrollRef });
  // Pinned to the latest message while it streams; a scroll-up releases it, scrolling back re-pins.
  // The stream outlives a session switch (same pane, new rows), so another session re-pins too.
  const stick = useStickToBottom(scrollRef, contentRef, { streamKey, changes: [rows, loading] });
  const team = useTeamRowSlot();

  const onScroll = (): void => {
    stick.onScroll();
    scheduleSync();
    win.onScroll();
  };

  // Jump to a prompt: put it just under the top edge, where the eye expects the thing it asked for.
  // Releasing the pin first matters — without it the next streamed frame would yank the view back
  // to the bottom mid-scroll. A prompt above the mounted window is mounted first.
  const jumpTo = (row: number): void => {
    stick.release();
    win.reveal(row, () => scrollToAnchor(scrollRef.current, row));
  };

  // New rows move every mark below them, so the active one is re-read after each change too.
  useEffect(() => {
    scheduleSync();
  }, [rows, loading, scheduleSync]);

  useEffect(() => () => {
    if (syncRaf.current && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(syncRaf.current);
  }, []);

  // Publish the pane's usable width so a block that should not obey the prose column can break out
  // of it (today: tables — see ChatMarkdown's TableBlock). The column is centred, so a block that
  // takes this width and pulls back half the difference lands centred on the pane. Written straight
  // to the node rather than through state: a pane resize must not re-render the whole transcript.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // …and the ceiling such a block may reach before it has to fold its content: twice the prose
    // column's own text width. Past two columns of reading width the eye stops tracking the row, so
    // a table wraps there instead of growing (ChatMarkdown's TableBlock). Constant, hence set once.
    el.style.setProperty('--chat-table-max-w', `${(COLUMN_W - GUTTER * 2) * 2}px`);
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

  // The rail is a sibling of the scroll box, not a child: it marks the transcript's whole length, so
  // it must not travel with the part of it that happens to be on screen.
  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflow: 'auto', minHeight: 0, scrollbarGutter: 'stable both-edges' }}>
        <div ref={contentRef} style={{ width: '100%', maxWidth: COLUMN_W, margin: '0 auto', padding: `${JUMP_MARGIN}px ${GUTTER}px 16px` }}>
          <ChatRows rows={rows} start={win.start} interactionActions={interactionActions} edit={edit} streamKey={streamKey} anchors group live={live} />
          {team?.tail}
          <SessionStateLine running={live} offset={14} />
        </div>
      </div>
      <ChatNavRail marks={marks} activeRows={activeRows} onJump={jumpTo} />
    </div>
  );
}
