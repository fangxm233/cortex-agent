import type { SessionTranscript, TranscriptMessage } from '@cortex-agent/ui-contract';
import type { Vocab } from '@/i18n';

// Pure view-model for the workbench center-chat transcript (S4 chat, task aba0). Maps the real
// `sessions.transcript` DTO (+ a live `session.message` tail) into the prototype's exact message-row
// model (prototype.dc.html L145–356). Real data is the only variable — the render (MessageStream)
// owns every px/hex/font/copy; this module only decides which rows exist and what text they carry.

/** A live `session.message` event payload (the tRPC subscribe UiEvent.payload for that event). */
export interface LiveSessionMessage {
  sessionId: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  toolName?: string;
  toolInput?: string;
  ts: string;
  /** Optional file attachments on user messages (15a). */
  attachments?: { name: string; path: string; size: number; mimeType: string; type: 'image' | 'video' | 'file' }[];
}

export type Attachment = { name: string; path: string; size: number; mimeType: string; type: 'image' | 'video' | 'file' };

export type ChatRow =
  | { kind: 'divider'; text: string }
  | { kind: 'user'; text: string; attachments?: Attachment[] }
  | { kind: 'tools'; count: number; calls: { kind: string; input: string }[] }
  // `attachments` carries agent-sent files (20a) — rendered as left-aligned file cards under the text.
  | { kind: 'assistant'; text: string; streaming: boolean; attachments?: Attachment[] };

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
  };
}

export function turnCount(transcript: SessionTranscript | undefined | null): number {
  return transcript?.turns.length ?? 0;
}

/**
 * Real session-level elapsed = sum of the backend's per-message `elapsedMs` (ts-derived) across all
 * turns. Null messages (first message, unparseable ts) contribute 0. Returns null when there is no
 * elapsed signal at all (empty / single-message / all-null) so the caller renders an honest `—`.
 */
export function sessionElapsedMs(transcript: SessionTranscript | undefined | null): number | null {
  if (!transcript) return null;
  let total = 0;
  let seen = false;
  for (const turn of transcript.turns) {
    for (const m of turn.messages) {
      if (m.elapsedMs != null) {
        total += m.elapsedMs;
        seen = true;
      }
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

function msgKey(m: TranscriptMessage): string {
  return `${m.type}|${m.ts}|${m.text ?? ''}|${m.toolName ?? ''}|${m.toolInput ?? ''}`;
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

function dayStamp(ts: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Build the ordered prototype chat-row list from the fetched transcript plus any live-tail events not
 * yet reflected in it. Consecutive tool messages collapse into one `tools` row; a `divider` is emitted
 * whenever the local calendar day changes (incl. before the first message); the last assistant row
 * carries the streaming caret when `opts.streaming` is set.
 */
export function buildTranscriptRows(
  transcript: SessionTranscript,
  liveTail: LiveSessionMessage[],
  opts: BuildOpts = {},
): ChatRow[] {
  const now = opts.now ?? new Date();

  const flat: TranscriptMessage[] = [];
  const seen = new Set<string>();
  const push = (m: TranscriptMessage): void => {
    const k = msgKey(m);
    if (seen.has(k)) return;
    seen.add(k);
    flat.push(m);
  };
  for (const turn of transcript.turns) for (const m of turn.messages) push(m);
  for (const lm of liveTail) push(liveToMessage(lm));

  const rows: ChatRow[] = [];
  let curDay: string | null = null;
  let toolBuf: { kind: string; input: string }[] = [];

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
      toolBuf.push({ kind: m.toolName ?? '', input: m.toolInput ?? '' });
      continue;
    }
    flushTools();
    if (m.type === 'user') rows.push({ kind: 'user', text: m.text ?? '', attachments: (m as any).attachments });
    else rows.push({ kind: 'assistant', text: m.text ?? '', streaming: false, attachments: (m as any).attachments });
  }
  flushTools();

  if (opts.streaming) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.kind === 'assistant') {
        rows[i] = { ...r, streaming: true };
        break;
      }
    }
  }

  return rows;
}
