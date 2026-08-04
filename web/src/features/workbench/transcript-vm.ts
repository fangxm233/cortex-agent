// input:  transcript DTOs with DEBUG warnings, notices, pending data
// output: ChatRows preserving auth actions, previews, and reconciliation
// pos:    Shared desktop/mobile transcript view-model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import type {
  AuthNoticeAction,
  ChatNoticeLevel,
  SessionTranscript,
  TranscriptInteractionDetail,
  TranscriptMessage,
} from '@cortex-agent/ui-contract';
import type { Vocab } from '@/i18n';

// Pure view-model for the workbench center-chat transcript (S4 chat, task aba0). Maps the real
// `sessions.transcript` DTO (+ a live `session.message` tail) into the prototype's exact message-row
// model (prototype.dc.html L145–356). Real data is the only variable — the render (MessageStream)
// owns every px/hex/font/copy; this module only decides which rows exist and what text they carry.
// It also says WHICH row is still being written (`preview` on the assistant row) — the one row whose
// text is still arriving, and therefore the only one the render paces.

/** A live `session.message` event payload (the tRPC subscribe UiEvent.payload for that event). */
export interface LiveSessionMessage {
  sessionId: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  toolName?: string;
  toolInput?: string;
  noticeLevel?: ChatNoticeLevel;
  authAction?: AuthNoticeAction;
  ts: string;
  /** Optional file attachments on user messages (15a). */
  attachments?: { name: string; path: string; size: number; mimeType: string; type: 'image' | 'video' | 'file' }[];
  /** Set on an assistant message whose text streamed as `session.message.delta` events first. It
   *  identifies the preview this message supersedes (see endStreamingBlock). */
  blockId?: string;
}

// ── Token-level streaming (`session.message.delta`) ─────────────────────────────────────────────
//
// A block being generated arrives as a series of increments sharing one `blockId`, then as the
// complete `session.message` carrying that same id. The preview is never truth: it exists to make
// a 20-second wait visible, and is discarded the moment the authoritative text lands.

/** The assistant text block currently being previewed. */
export interface StreamingBlock {
  blockId: string;
  /** Everything received for this block so far. */
  text: string;
}

/** A `session.message.delta` payload. `text` is the increment since this block's previous event. */
export interface AssistantDeltaEvent {
  blockId?: string;
  text?: string;
  seq?: number;
}

/**
 * Fold one delta into the preview. A different `blockId` starts a fresh block rather than
 * concatenating across blocks (the model wrote a second paragraph block, or a new message began);
 * a malformed event leaves the previous state untouched, so a dropped field can never blank the
 * bubble mid-stream.
 */
export function applyAssistantDelta(
  prev: StreamingBlock | null,
  ev: AssistantDeltaEvent,
): StreamingBlock | null {
  const { blockId, text } = ev;
  if (typeof blockId !== 'string' || !blockId) return prev;
  if (typeof text !== 'string' || !text) return prev;
  if (!prev || prev.blockId !== blockId) return { blockId, text };
  return { blockId, text: prev.text + text };
}

/**
 * Retire the preview when a complete assistant message arrives. Cleared when it is the same block
 * (the normal handover) and also when the message carries no blockId at all — a backend that did
 * not stream must never leave a half-written bubble stranded on screen. A message for a DIFFERENT
 * block leaves the current preview alone.
 */
export function endStreamingBlock(
  prev: StreamingBlock | null,
  messageBlockId: string | undefined,
): StreamingBlock | null {
  if (!prev) return null;
  if (!messageBlockId) return null;
  return messageBlockId === prev.blockId ? null : prev;
}

const FINALIZED_BLOCK_CAP = 32;

/** Preview state spans both SSE connections: finalized ids stop a late delta from reopening a row. */
export interface AssistantPreviewState {
  active: StreamingBlock | null;
  finalizedBlockIds: readonly string[];
}

export function initialAssistantPreviewState(): AssistantPreviewState {
  return { active: null, finalizedBlockIds: [] };
}

export function applyAssistantPreviewDelta(
  state: AssistantPreviewState,
  ev: AssistantDeltaEvent,
): AssistantPreviewState {
  const blockId = ev.blockId;
  if (!blockId || state.finalizedBlockIds.includes(blockId)) return state;
  const active = applyAssistantDelta(state.active, ev);
  return active === state.active ? state : { ...state, active };
}

export function finalizeAssistantPreview(
  state: AssistantPreviewState,
  messageBlockId: string | undefined,
): AssistantPreviewState {
  const finalizedId = messageBlockId ?? state.active?.blockId;
  const active = endStreamingBlock(state.active, messageBlockId);
  if (!finalizedId || state.finalizedBlockIds.includes(finalizedId)) return { ...state, active };
  const finalizedBlockIds = [...state.finalizedBlockIds, finalizedId].slice(-FINALIZED_BLOCK_CAP);
  return { active, finalizedBlockIds };
}

export type Attachment = { name: string; path: string; size: number; mimeType: string; type: 'image' | 'video' | 'file' };

// ── A user message the model has not read yet (`pending` / `session.message.delivered`) ─────────
//
// Sending while a turn is running writes the message into the backend's stdin, which only QUEUES it
// there: the model reads it at the next agent-loop boundary, which can be seconds away or after the
// current turn has finished answering something else entirely. Until it is read, the message is not
// part of the conversation — everything the agent is emitting was produced without it — so it is
// held OUT of the ordered stream and shown as a provisional row pinned to the bottom. The delivered
// event is the moment it was read: it enters the stream there, under the ts it was recorded with.

/** An injected message surfaced but not yet read by the model. `ts` is the write-time key the
 *  `session.message` carried; it is replaced by the committed ts when the delivered event lands. */
export interface PendingUserMessage {
  /** Stable durable identity. Absent only for live events from older servers. */
  id?: string;
  ts: string;
  text: string;
  attachments?: Attachment[];
}

/** A `session.message.delivered` payload. */
export interface DeliveredEvent {
  sessionId?: string;
  /** Stable durable identity. When present it takes precedence over the legacy timestamp key. */
  pendingId?: string;
  /** The pending row's key. */
  messageTs?: string;
  /** The conversation-history key it is re-keyed to — what a transcript refetch returns. */
  committedTs?: string;
}

/**
 * Move the acked message out of the pending list and into the ordered stream. The returned
 * `committed` message is appended to the LIVE TAIL, i.e. after everything already emitted — which is
 * exactly where the model read it. Keyed by `committedTs` so it dedupes against the same record when
 * the transcript refetches. An ack for an unknown message changes nothing (a stale ack, or one for a
 * row this client never saw); a server that sent no `committedTs` falls back to the pending key.
 */
export function applyDelivered(
  pending: PendingUserMessage[],
  ev: DeliveredEvent,
): { pending: PendingUserMessage[]; committed: LiveSessionMessage | null } {
  const { messageTs, pendingId } = ev;
  if (!pendingId && !messageTs) return { pending, committed: null };
  const idx = pendingId
    ? pending.findIndex((p) => p.id === pendingId)
    : pending.findIndex((p) => p.ts === messageTs);
  if (idx === -1) return { pending, committed: null };
  const entry = pending[idx];
  return {
    pending: pending.filter((_, i) => i !== idx),
    committed: {
      sessionId: ev.sessionId ?? '',
      role: 'user',
      text: entry.text,
      ts: ev.committedTs || entry.ts,
      attachments: entry.attachments,
    },
  };
}

/**
 * Drop pending entries the authoritative transcript already holds. The delta/live streams are lossy
 * by design, so a delivered event can be lost to a dropped frame — without this the row would stay
 * dimmed forever even though the message was read and recorded. A record only clears a pending entry
 * if it was written at or after the send (an identical message sent EARLIER in the session is a
 * different message), and each record clears at most one entry, so sending the same text twice needs
 * two records. Returns the input array unchanged when nothing matched, so a refetch cannot loop the
 * caller's state.
 */
export function reconcilePendingUserMessages(
  pending: PendingUserMessage[],
  transcript: SessionTranscript | undefined | null,
  deliveredIds?: ReadonlySet<string>,
): PendingUserMessage[] {
  if (!transcript) return pending;
  // Current servers include an explicit durable snapshot (including []); it is authoritative for
  // reload, session switch, reconnect, and another device's commit. A delivered-id tombstone blocks
  // an older in-flight snapshot response from resurrecting a row after its later SSE commit. Undefined
  // means an older server, where the legacy committed-row reconciliation below is the only signal.
  if (transcript.pendingUserMessages !== undefined) {
    return transcript.pendingUserMessages
      .filter((message) => !deliveredIds?.has(message.id))
      .map((message) => ({ ...message }));
  }
  if (pending.length === 0) return pending;
  const records: { text: string; ts: string }[] = [];
  for (const turn of transcript.turns) {
    for (const m of turn.messages) {
      if (m.type === 'user') records.push({ text: m.text ?? '', ts: m.ts });
    }
  }
  const kept: PendingUserMessage[] = [];
  for (const p of pending) {
    const i = records.findIndex((r) => r.text === p.text && r.ts >= p.ts);
    if (i === -1) kept.push(p);
    else records.splice(i, 1);
  }
  return kept.length === pending.length ? pending : kept;
}

export interface DebugToolDetail {
  toolInput: unknown;
  toolResult?: { content: string; isError: boolean };
  overCharacterThreshold?: true;
}

export type ChatRow =
  | { kind: 'divider'; text: string }
  // `turnIndex` is the rewind anchor (sessions.rewind) — absent on live-tail rows (not editable
  // until the transcript reconciles). `edited` backs the「已编辑」badge + original-message card;
  // `ts` backs its HH:MM stamp. `pending` marks a message written to the backend but not yet read
  // by the model: it renders in dimmed ink, pinned below everything the agent is currently saying.
  | { kind: 'user'; text: string; attachments?: Attachment[]; turnIndex?: number; ts?: string; edited?: { originalText: string; originalTs: string }; pending?: boolean; debug?: { agentMessage: string } }
  | { kind: 'tools'; count: number; calls: { kind: string; input: string; debug?: DebugToolDetail }[] }
  // `attachments` carries agent-sent files (20a) — rendered as left-aligned file cards under the text.
  // `preview` marks the ONE row that is the block being written right now (the token-level
  // accumulation), as opposed to a message the backend has committed. `streaming` cannot express
  // this: the idle heuristic also flags the last COMPLETE assistant row for a couple of seconds
  // after the final event. Only a preview row is paced by the smooth reveal — pacing a settled
  // message would re-type text the reader has already seen and leave it animating past turn end.
  | { kind: 'assistant'; text: string; streaming: boolean; attachments?: Attachment[]; preview?: true }
  | { kind: 'notice'; level: ChatNoticeLevel; text: string; authAction?: AuthNoticeAction }
  // `detail` carries the structured interaction entity (pending cards render actionable);
  // absent on legacy rows, which render the old subtype-driven summary.
  | { kind: 'interaction'; subtype: string; text: string; detail?: TranscriptInteractionDetail; ts?: string | null };

export interface BuildOpts {
  /** True while the session is actively producing output — marks the last assistant row's caret. */
  streaming?: boolean;
  /** Injected clock for deterministic day-relative divider labels (defaults to Date.now). */
  now?: Date;
  /**
   * Optional divider-label override (e.g. the mobile 5a screen's ZH 今天/昨天 dividers). Defaults to
   * the EN `dividerLabel` (TODAY / YESTERDAY / "MON D"). Receives the first message ts of the day.
   */
  formatDivider?: (ts: string, now: Date) => string;
  /**
   * Text accumulated for the assistant block currently being written (token-level streaming).
   * Rendered as one extra assistant row at the very end, flagged `streaming`. The row
   * disappears the moment the hook retires the preview, which is the same render pass in which the
   * complete message enters the live tail — so the text never flickers or doubles.
   */
  streamingText?: string | null;
  /**
   * Messages written into the running turn's backend but not yet read by the model. They render as
   * the LAST rows of the stream — below the streaming preview too — in send order among themselves,
   * flagged `pending`. Anything the agent says while they sit here was said without them, which is
   * why they are not merged into the ordered tail until the delivered event moves them there.
   */
  pendingUser?: PendingUserMessage[];
}

/** Map a live `session.message` event into a `TranscriptMessage` (same shape the fetched DTO uses).
 *  `elapsedMs` is null for live-tail messages — the backend derives real per-message elapsed at read
 *  time, so it reconciles when the transcript refetches after the stream settles. */
export function liveToMessage(m: LiveSessionMessage): TranscriptMessage {
  const isTool = m.role === 'tool';
  return {
    type: m.role,
    text: isTool ? null : (m.text ?? ''),
    toolName: isTool ? (m.toolName ?? '') : null,
    toolInput: isTool ? (m.toolInput ?? '') : null,
    ts: m.ts,
    elapsedMs: null,
    attachments: m.attachments,
    ...(m.noticeLevel ? { noticeLevel: m.noticeLevel } : {}),
    ...(m.authAction ? { authAction: m.authAction } : {}),
  };
}

export function turnCount(transcript: SessionTranscript | undefined | null): number {
  return transcript?.turns.length ?? 0;
}

/**
 * Real CURRENT-turn elapsed = wall-clock span within the last turn only (its opening user message →
 * its last assistant/tool message). The first message of a turn carries the idle gap since the
 * previous turn (the backend's `prevMs` spans turn boundaries), so its `elapsedMs` is excluded — only
 * intra-turn deltas are summed. Returns null when the last turn has no intra-turn elapsed signal
 * (empty / single-message / all-null) so the caller renders an honest `—`.
 */
export function currentTurnElapsedMs(transcript: SessionTranscript | undefined | null): number | null {
  if (!transcript || transcript.turns.length === 0) return null;
  const lastTurn = transcript.turns[transcript.turns.length - 1];
  let total = 0;
  let seen = false;
  // Skip index 0 (the turn-opening user message) — its elapsedMs is the cross-turn idle gap.
  for (let i = 1; i < lastTurn.messages.length; i++) {
    const ms = lastTurn.messages[i].elapsedMs;
    if (ms != null) {
      total += ms;
      seen = true;
    }
  }
  return seen ? total : null;
}

/**
 * Snapshot + delta running resolution. Precedence:
 *   1. `statusRunning` — the live `session.status` event (delta), authoritative once received;
 *   2. `snapshotRunning` — the sessions.list `running` snapshot, restores state on mount /
 *      session switch / page reload / SSE reconnect before any event arrives;
 *   3. `streaming` — the message-stream idle heuristic, last resort for servers whose
 *      sessions.list carries no `running` field yet.
 */
export function resolveRunning(
  statusRunning: boolean | null,
  snapshotRunning: boolean | undefined,
  streaming: boolean,
): boolean {
  return statusRunning ?? snapshotRunning ?? streaming;
}

/**
 * Snapshot + delta background-hold resolution (mirrors resolveRunning). Precedence:
 *   1. `statusBackground` — derived from the live `session.status` event (running &&
 *      backgroundRunning), authoritative once any status event was received (null before);
 *   2. `snapshotBackground` — the sessions.list `backgroundRunning` snapshot, restores the
 *      Background state on mount / session switch / reload / app restart;
 *   3. false — old servers whose sessions.list carries no `backgroundRunning` field.
 */
export function resolveBackgroundRunning(
  statusBackground: boolean | null,
  snapshotBackground: boolean | undefined,
): boolean {
  return statusBackground ?? snapshotBackground ?? false;
}

/**
 * Snapshot + delta resolution for the composer's REAL agent-turn count. Precedence:
 *   1. `liveTurns` — the live `session.turn` event (delta), authoritative once received (a real 0 wins);
 *   2. `snapshotTurns` — the sessions.list `numTurns` snapshot, restores the count on mount / session
 *      switch / reload before any event arrives;
 *   3. `null` — unknown (a running turn before its first progress event, or a session that never ran).
 */
export function resolveTurns(liveTurns: number | null, snapshotTurns: number | null | undefined): number | null {
  return liveTurns ?? snapshotTurns ?? null;
}

/** Compact human-readable duration for the composer status line; `—` for null (never fabricated). */
export function formatElapsed(ms: number | null): string {
  if (ms == null) return '—';
  const totalS = Math.floor(ms / 1000);
  if (totalS < 60) return `${totalS}s`;
  const totalM = Math.floor(totalS / 60);
  if (totalM < 60) return `${totalM}m ${totalS % 60}s`;
  const h = Math.floor(totalM / 60);
  return `${h}h ${totalM % 60}m`;
}

/**
 * What an edit at `rowIndex` (a user row) would discard: the count of assistant replies and tool
 * calls after that row. Backs the「发送后回退其后 N 条回复 · M 次工具调用作废」line (desktop 23a)
 * and the mobile「将被回退 · N 条回复 · M 次工具调用」badge (7b).
 */
export function rewindStats(rows: ChatRow[], rowIndex: number): { replies: number; toolCalls: number } {
  let replies = 0;
  let toolCalls = 0;
  for (let i = rowIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind === 'assistant') replies++;
    else if (r.kind === 'tools') toolCalls += r.count;
  }
  return { replies, toolCalls };
}

/** Row indexes carrying the「由编辑重新生成」footnote: the first assistant row after each edited
 *  user row (stops at the next user row). Shared by the desktop MessageStream + mobile MChatStream. */
export function regenNoteIndexes(rows: ChatRow[]): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind !== 'user' || !r.edited) continue;
    for (let j = i + 1; j < rows.length; j++) {
      const k = rows[j].kind;
      if (k === 'user') break;
      if (k === 'assistant') { out.add(j); break; }
    }
  }
  return out;
}

function msgKey(m: TranscriptMessage): string {
  // Interaction entities have a stable id — key on it so a status change (pending → approved)
  // REPLACES the row instead of duplicating it.
  if (m.type === 'interaction' && m.interaction?.id) return `interaction|${m.interaction.id}`;
  const noticeId = m.authAction?.noticeId ?? '';
  return `${m.type}|${m.ts}|${m.text ?? ''}|${m.toolName ?? ''}|${m.toolInput ?? ''}|${m.noticeLevel ?? ''}|${noticeId}`;
}

// Relative-day label matching the prototype divider vocabulary (TODAY / YESTERDAY / "MON D"),
// computed against the local calendar day. HH:MM is the local wall-clock of the first message.
function dividerLabel(ts: string, now: Date): string {
  const d = new Date(ts);
  const startOf = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDelta = Math.round((startOf(now) - startOf(d)) / 86400000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;
  if (dayDelta <= 0) return `TODAY ${time}`;
  if (dayDelta === 1) return `YESTERDAY ${time}`;
  const mon = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  return `${mon} ${d.getDate()} ${time}`;
}

/** Returns a formatDivider callback that uses the given vocab for TODAY / YESTERDAY labels. */
export function formatDividerFromVocab(L: Vocab): (ts: string, now: Date) => string {
  return (ts: string, now: Date) => {
    const d = new Date(ts);
    const startOf = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const dayDelta = Math.round((startOf(now) - startOf(d)) / 86400000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const time = `${hh}:${mm}`;
    if (dayDelta <= 0) return `${L.wbSessionToday} ${time}`;
    if (dayDelta === 1) return `${L.wbSessionYesterday} ${time}`;
    const mon = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
    return `${mon} ${d.getDate()} ${time}`;
  };
}

/**
 * Send-time stamp for a single message, as revealed on desktop hover / mobile long-press. `HH:MM`
 * while the message is from today; `MM-DD HH:MM` on any other day; `YYYY-MM-DD HH:MM` once the year
 * differs. The day dividers already date each run of messages, so the common case stays a bare
 * clock — the date only appears where a reader scrolled back far enough to have lost the divider.
 * Returns null for a missing or unparseable ts so the caller can skip the affordance entirely.
 */
export function messageTimeLabel(ts: string | undefined, now: Date = new Date()): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return time;
  const date = `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return `${d.getFullYear() === now.getFullYear() ? date : `${d.getFullYear()}-${date}`} ${time}`;
}

function dayStamp(ts: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Build the ordered prototype chat-row list from the fetched transcript plus any live-tail events not
 * yet reflected in it. Consecutive tool messages collapse into one `tools` row; a `divider` is emitted
 * whenever the local calendar day changes (incl. before the first message); the last assistant row
 * is flagged `streaming` when `opts.streaming` is set (the desktop stream renders no caret for it;
 * the mobile stream does).
 */
export function buildTranscriptRows(
  transcript: SessionTranscript,
  liveTail: LiveSessionMessage[],
  opts: BuildOpts = {},
): ChatRow[] {
  const now = opts.now ?? new Date();

  const flat: (TranscriptMessage & { turnIndex?: number })[] = [];
  const seen = new Set<string>();
  const push = (m: TranscriptMessage, turnIndex?: number): void => {
    const k = msgKey(m);
    if (seen.has(k)) return;
    seen.add(k);
    flat.push(turnIndex !== undefined ? { ...m, turnIndex } : m);
  };
  for (const turn of transcript.turns) for (const m of turn.messages) push(m, turn.turnIndex);
  for (const lm of liveTail) push(liveToMessage(lm));

  const rows: ChatRow[] = [];
  let curDay: string | null = null;
  let toolBuf: { kind: string; input: string; debug?: DebugToolDetail }[] = [];

  const flushTools = (): void => {
    if (toolBuf.length === 0) return;
    rows.push({ kind: 'tools', count: toolBuf.length, calls: toolBuf });
    toolBuf = [];
  };

  for (const m of flat) {
    const day = dayStamp(m.ts);
    if (day !== curDay) {
      flushTools();
      const label = opts.formatDivider ? opts.formatDivider(m.ts, now) : dividerLabel(m.ts, now);
      rows.push({ kind: 'divider', text: label });
      curDay = day;
    }
    if (m.type === 'tool') {
      const debug = (m as TranscriptMessage & { debug?: DebugToolDetail }).debug;
      toolBuf.push({
        kind: m.toolName ?? '',
        input: m.toolInput ?? '',
        ...(debug && (debug.toolInput !== undefined || debug.toolResult !== undefined)
          ? { debug: {
              toolInput: debug.toolInput,
              ...(debug.toolResult !== undefined ? { toolResult: debug.toolResult } : {}),
              ...(debug.overCharacterThreshold === true ? { overCharacterThreshold: true as const } : {}),
            } }
          : {}),
      });
      continue;
    }
    flushTools();
    if (m.type === 'interaction') {
      rows.push({ kind: 'interaction', subtype: (m as any).subtype ?? '', text: m.text ?? '', detail: m.interaction, ts: m.ts ?? null });
    } else if (m.type === 'user') {
      rows.push({
        kind: 'user', text: m.text ?? '', attachments: (m as any).attachments,
        ...(m.turnIndex !== undefined ? { turnIndex: m.turnIndex } : {}),
        ...(m.ts ? { ts: m.ts } : {}),
        ...((m as any).edited !== undefined ? { edited: (m as any).edited } : {}),
        ...((m as any).debug?.agentMessage !== undefined ? { debug: { agentMessage: (m as any).debug.agentMessage } } : {}),
      });
    } else if (m.type === 'assistant' && m.noticeLevel) {
      rows.push({
        kind: 'notice', level: m.noticeLevel, text: m.text ?? '',
        ...(m.authAction ? { authAction: m.authAction } : {}),
      });
    } else {
      rows.push({ kind: 'assistant', text: m.text ?? '', streaming: false, attachments: (m as any).attachments });
    }
  }
  flushTools();

  // The in-flight block, after every persisted/live message and after any tool row of this turn.
  // Flagged `preview`: this is the only row whose text is still arriving, so it is the only one the
  // smooth reveal paces.
  if (opts.streamingText) {
    rows.push({ kind: 'assistant', text: opts.streamingText, streaming: true, preview: true });
  }

  if (opts.streaming) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.kind === 'assistant') {
        rows[i] = { ...r, streaming: true };
        break;
      }
    }
  }

  // Last of all: the messages the model has not read yet. Everything above them — including the
  // block being written right now — was produced without them, so they cannot sit any higher.
  for (const p of opts.pendingUser ?? []) {
    rows.push({ kind: 'user', text: p.text, attachments: p.attachments, ts: p.ts, pending: true });
  }

  return rows;
}
