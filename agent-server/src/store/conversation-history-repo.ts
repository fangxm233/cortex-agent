// input:  per-session JSONL, visible events, interactions/edit markers, optional DEBUG sidecars
// output: backend-independent history with turn grouping and correlated lossless debug metadata
// pos:    L1 append-only canonical transcript store; all grouping/merging occurs at read time
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import { promises as fs } from 'fs';
import { STORE_DIR } from '@core/paths.js';

const HISTORY_DIR = path.join(STORE_DIR, 'conversation-history');

// --- Types ---

export type HistoryEventType = 'user' | 'assistant' | 'tool' | 'interaction';

export interface HistoryDebugDetails {
  /** Exact text handed to the adapter for this user turn. */
  agentMessage?: string;
  /** Unabridged structured input for a tool call. */
  toolInput?: unknown;
  /** Full normalized result correlated to the tool call by backend tool-use id. */
  toolResult?: { content: string; isError: boolean };
}

// ── Interaction entity types (web-interactions-redesign) ─────────────────────
// An interaction (ask-user question / plan approval) is a first-class persisted entity:
// a `created` record (status pending, full payload snapshot) and a later `resolved` record
// (final status + result) share the same `id` and are MERGED into one event at read time.

export type InteractionKind = 'ask-user' | 'plan-approval';
export type InteractionStatus = 'pending' | 'answered' | 'approved' | 'rejected' | 'expired' | 'cancelled';
export type InteractionResolvedVia = 'web' | 'slack' | 'timeout' | 'restart' | 'command';

export interface InteractionQuestion {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

export interface InteractionPayload {
  questions?: InteractionQuestion[];
  planContent?: string;
  planFilePath?: string | null;
}

export interface InteractionResult {
  answers?: Record<string, string>;
  feedback?: string;
}

/** A resolved history event (turnIndex derived at read time). */
export interface HistoryEvent {
  type: HistoryEventType;
  /** user / assistant message text (omitted for tool events). */
  text?: string;
  /** tool name (tool events only). */
  toolName?: string;
  /** compact tool input summary (tool events only). */
  toolInput?: string;
  /** Sensitive lossless fields captured only by DEBUG-enabled orchestration. */
  debug?: HistoryDebugDetails;
  /** interaction subtype: 'ask-user-answered' | 'plan-approved' | 'plan-rejected' (LEGACY interaction rows only). */
  subtype?: string;
  /** Interaction entity fields (interaction rows with an id; merged created+resolved on read). */
  id?: string;
  kind?: InteractionKind;
  status?: InteractionStatus;
  payload?: InteractionPayload;
  result?: InteractionResult;
  resolvedVia?: InteractionResolvedVia;
  resolvedAt?: string;
  ts: string;
  /** Groups events under the user turn that triggered them. */
  turnIndex: number;
  /** Optional file attachments (user events from web composer). */
  attachments?: { name: string; path: string; size: number; mimeType: string; type: 'image' | 'video' | 'file' }[];
  /** Present on a user event that replaced an earlier message via edit+rewind. Derived on read
   *  from the preceding `edit-marker` raw line (the marker itself is never emitted). */
  edited?: { originalText: string; originalTs: string };
}

/** Raw line as persisted (no turnIndex — derived on read).
 *  `edit-marker` is a persistence-only line (message edit + rewind): appended right before the
 *  edited user event's re-send; on read it attaches to the NEXT user event as `edited` and is
 *  never emitted as an event itself. */
interface RawEvent {
  type: HistoryEventType | 'edit-marker' | 'debug-user-prompt' | 'debug-tool-result';
  /** edit-marker lines only. */
  originalText?: string;
  /** edit-marker lines only. */
  originalTs?: string;
  text?: string;
  toolName?: string;
  toolInput?: string;
  /** DEBUG-only correlation and lossless payload fields. */
  toolUseId?: string;
  fullInput?: unknown;
  agentMessage?: string;
  isError?: boolean;
  /** interaction subtype (LEGACY interaction lines only). */
  subtype?: string;
  /** Interaction entity fields (created / resolved lines). */
  id?: string;
  kind?: InteractionKind;
  status?: InteractionStatus;
  payload?: InteractionPayload;
  result?: InteractionResult;
  resolvedVia?: InteractionResolvedVia;
  ts: string;
  /** Optional file attachments (user events from web composer). */
  attachments?: { name: string; path: string; size: number; mimeType: string; type: 'image' | 'video' | 'file' }[];
}

export interface SessionHistory {
  sessionId: string;
  events: HistoryEvent[];
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Compact, backend-agnostic one-line summary of a tool call's input for the history.
 *  Shared by the direct conversation path (agent-runner) and thread steps (thread-transcript)
 *  so both record identical tool-input summaries. */
export function summarizeToolInputForHistory(input: any): string {
  if (input == null || typeof input !== 'object') return '';
  const pick = (k: string) => (typeof input[k] === 'string' ? input[k] : undefined);
  const primary = pick('command') ?? pick('file_path') ?? pick('path') ?? pick('pattern') ?? pick('url') ?? pick('prompt') ?? pick('description') ?? pick('query');
  let s = primary ?? '';
  if (!s) {
    try { s = JSON.stringify(input); } catch { s = ''; }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

function isPrefixRelated(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/** UUID sessionIds are filename-safe; sanitize defensively all the same. */
function sessionFile(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(HISTORY_DIR, `${safe}.jsonl`);
}

// --- Repo ---

export class ConversationHistoryRepo {
  /** Per-session serial write chain — keeps concurrent appends from interleaving a line. */
  private writeChains = new Map<string, Promise<void>>();
  private dirReady = false;

  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    await fs.mkdir(HISTORY_DIR, { recursive: true });
    this.dirReady = true;
  }

  private append(sessionId: string, ev: RawEvent): Promise<void> {
    const prev = this.writeChains.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        await this.ensureDir();
        await fs.appendFile(sessionFile(sessionId), JSON.stringify(ev) + '\n', 'utf8');
      });
    this.writeChains.set(sessionId, next);
    return next;
  }

  /** Append a user message — starts a new turn (turn boundaries are derived on read).
   *  An optional `ts` override lets the caller share a single timestamp with the
   *  EventBus event so the web UI's content-based de-dup produces identical keys. */
  appendUser(sessionId: string, opts: { text: string; ts?: string; attachments?: { name: string; path: string; size: number; mimeType: string; type: 'image' | 'video' | 'file' }[]; agentMessage?: string }): Promise<void> {
    return this.append(sessionId, {
      type: 'user',
      text: opts.text,
      ts: opts.ts ?? nowIso(),
      attachments: opts.attachments,
      agentMessage: opts.agentMessage,
    });
  }

  /** Attach the exact adapter message after prompt assembly to the preceding visible user row. */
  appendUserPrompt(sessionId: string, opts: { agentMessage: string; ts?: string }): Promise<void> {
    return this.append(sessionId, { type: 'debug-user-prompt', agentMessage: opts.agentMessage, ts: opts.ts ?? nowIso() });
  }

  /** Append an assistant message. Streaming partials are collapsed at read time.
   *  An optional `ts` override lets the caller share a single timestamp with the EventBus event.
   *  Optional `attachments` carry agent-sent files (20a) — the assistant-side mirror of the user
   *  composer's uploads. Present only for the file-send path; ordinary assistant text omits it. */
  appendAssistant(sessionId: string, opts: { text: string; ts?: string; attachments?: { name: string; path: string; size: number; mimeType: string; type: 'image' | 'video' | 'file' }[] }): Promise<void> {
    return this.append(sessionId, { type: 'assistant', text: opts.text, ts: opts.ts ?? nowIso(), attachments: opts.attachments });
  }

  /** Append a tool call.
   *  An optional `ts` override lets the caller share a single timestamp with the EventBus event. */
  appendTool(sessionId: string, opts: { toolName: string; toolInput?: string; ts?: string; toolUseId?: string; fullInput?: unknown }): Promise<void> {
    return this.append(sessionId, {
      type: 'tool',
      toolName: opts.toolName,
      toolInput: opts.toolInput ?? '',
      ts: opts.ts ?? nowIso(),
      toolUseId: opts.toolUseId,
      fullInput: opts.fullInput,
    });
  }

  /** Append a full normalized tool result; read-time correlation keeps it on the tool row. */
  appendToolResult(sessionId: string, opts: { toolUseId: string; content: string; isError: boolean; ts?: string }): Promise<void> {
    return this.append(sessionId, {
      type: 'debug-tool-result',
      toolUseId: opts.toolUseId,
      text: opts.content,
      isError: opts.isError,
      ts: opts.ts ?? nowIso(),
    });
  }

  /** Append an interaction CREATED record (status pending, full payload snapshot).
   *  The later resolved record with the same id merges into this row at read time. */
  appendInteractionCreated(sessionId: string, opts: { id: string; kind: InteractionKind; payload: InteractionPayload; text: string; ts?: string }): Promise<void> {
    return this.append(sessionId, { type: 'interaction', id: opts.id, kind: opts.kind, status: 'pending', payload: opts.payload, text: opts.text, ts: opts.ts ?? nowIso() });
  }

  /** Append an interaction RESOLVED record (final status + result). Merged into the created
   *  row by id at read time; kept standalone if no created row exists (defensive). */
  appendInteractionResolved(sessionId: string, opts: { id: string; status: InteractionStatus; result?: InteractionResult; resolvedVia: InteractionResolvedVia; text: string; ts?: string }): Promise<void> {
    return this.append(sessionId, { type: 'interaction', id: opts.id, status: opts.status, result: opts.result, resolvedVia: opts.resolvedVia, text: opts.text, ts: opts.ts ?? nowIso() });
  }

  /** Append an EDIT MARKER (message edit + rewind): records the replaced message's original
   *  text/ts so the next user event reads back with an `edited` field. Call after
   *  {@link truncateFromTurn} and before re-sending the edited message. */
  appendEditMarker(sessionId: string, opts: { originalText: string; originalTs: string }): Promise<void> {
    return this.append(sessionId, { type: 'edit-marker', originalText: opts.originalText, originalTs: opts.originalTs, ts: nowIso() });
  }

  /**
   * Rewind support: drop every line from the `turnIndex`-th user event onward (plus a directly
   * preceding edit-marker, which belonged to the removed user event). Serialized on the same
   * per-session write chain as appends. Returns the removed opening user event's text/ts/attachments
   * (for the edit marker + attachment reuse), or null when the turn does not exist.
   */
  async truncateFromTurn(sessionId: string, turnIndex: number): Promise<{ text: string; ts: string; attachments?: RawEvent['attachments'] } | null> {
    let removed: { text: string; ts: string; attachments?: RawEvent['attachments'] } | null = null;
    const prev = this.writeChains.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        let raw: string;
        try {
          raw = await fs.readFile(sessionFile(sessionId), 'utf8');
        } catch {
          return; // no history — nothing to truncate
        }
        const lines = raw.split('\n').filter(l => l.trim());
        let userCount = 0;
        let cutAt = -1;
        for (let i = 0; i < lines.length; i++) {
          let ev: RawEvent;
          try { ev = JSON.parse(lines[i]) as RawEvent; } catch { continue; }
          if (ev.type === 'user') {
            if (userCount === turnIndex) {
              cutAt = i;
              removed = { text: ev.text ?? '', ts: ev.ts, ...(ev.attachments !== undefined ? { attachments: ev.attachments } : {}) };
              break;
            }
            userCount++;
          }
        }
        if (cutAt === -1) return; // turn out of range — no-op
        // Drop a marker line directly preceding the cut: it described the removed user event.
        let keepEnd = cutAt;
        if (keepEnd > 0) {
          try {
            const prevEv = JSON.parse(lines[keepEnd - 1]) as RawEvent;
            if (prevEv.type === 'edit-marker') keepEnd--;
          } catch { /* keep as is */ }
        }
        const kept = lines.slice(0, keepEnd);
        await fs.writeFile(sessionFile(sessionId), kept.length ? kept.join('\n') + '\n' : '', 'utf8');
      });
    this.writeChains.set(sessionId, next);
    await next;
    return removed;
  }

  /**
   * Read a session's history. Derives turnIndex (each `user` event opens a new turn) and
   * collapses consecutive same-turn assistant events whose texts are prefix-related (a
   * streaming backend that emitted the message as it grew). Returns null when absent/empty.
   */
  async getHistory(sessionId: string): Promise<SessionHistory | null> {
    let raw: string;
    try {
      raw = await fs.readFile(sessionFile(sessionId), 'utf8');
    } catch {
      return null;
    }

    const events: HistoryEvent[] = [];
    // Interaction entity merge: id → the created row already pushed into `events`.
    // A later resolved line with the same id updates that row in place (position kept).
    const interactionById = new Map<string, HistoryEvent>();
    // DEBUG sidecars merge into visible rows and never affect transcript ordering or turn indexes.
    const toolByUseId = new Map<string, HistoryEvent>();
    let lastUser: HistoryEvent | null = null;
    let turnIndex = -1;
    // Pending edit-marker: attaches to the NEXT user event as `edited` (never emitted itself).
    let pendingEdit: { originalText: string; originalTs: string } | null = null;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let ev: RawEvent;
      try { ev = JSON.parse(line) as RawEvent; } catch { continue; }

      if (ev.type === 'edit-marker') {
        pendingEdit = { originalText: ev.originalText ?? '', originalTs: ev.originalTs ?? '' };
      } else if (ev.type === 'debug-user-prompt') {
        if (lastUser && ev.agentMessage !== undefined) {
          lastUser.debug = { ...(lastUser.debug ?? {}), agentMessage: ev.agentMessage };
        }
      } else if (ev.type === 'debug-tool-result') {
        const tool = ev.toolUseId ? toolByUseId.get(ev.toolUseId) : undefined;
        if (tool) {
          tool.debug = {
            ...(tool.debug ?? {}),
            toolResult: { content: ev.text ?? '', isError: ev.isError === true },
          };
        }
      } else if (ev.type === 'user') {
        turnIndex++;
        const user: HistoryEvent = {
          type: 'user', text: ev.text ?? '', ts: ev.ts, turnIndex, attachments: ev.attachments,
          ...(pendingEdit ? { edited: pendingEdit } : {}),
          ...(ev.agentMessage !== undefined ? { debug: { agentMessage: ev.agentMessage } } : {}),
        };
        events.push(user);
        lastUser = user;
        pendingEdit = null;
      } else if (ev.type === 'assistant') {
        const tIdx = Math.max(0, turnIndex);
        const last = events[events.length - 1];
        const text = ev.text ?? '';
        // An assistant event carrying file attachments (agent-sent file, 20a) is a distinct card —
        // never fold it into a preceding streamed text block, and never fold a later text block into
        // it (the empty-caption case is prefix-related to any text and would otherwise swallow it).
        const hasAttachments = ev.attachments !== undefined;
        const canCollapse =
          !hasAttachments &&
          !!last &&
          last.type === 'assistant' &&
          last.turnIndex === tIdx &&
          last.attachments === undefined &&
          typeof last.text === 'string' &&
          isPrefixRelated(last.text, text);
        if (canCollapse) {
          if (text.length >= last!.text!.length) { last!.text = text; last!.ts = ev.ts; }
        } else {
          events.push({ type: 'assistant', text, ts: ev.ts, turnIndex: tIdx, ...(hasAttachments ? { attachments: ev.attachments } : {}) });
        }
      } else if (ev.type === 'tool') {
        const tool: HistoryEvent = {
          type: 'tool',
          toolName: ev.toolName ?? '',
          toolInput: ev.toolInput ?? '',
          ts: ev.ts,
          turnIndex: Math.max(0, turnIndex),
          ...(ev.fullInput !== undefined ? { debug: { toolInput: ev.fullInput } } : {}),
        };
        events.push(tool);
        if (ev.toolUseId) toolByUseId.set(ev.toolUseId, tool);
      } else if (ev.type === 'interaction') {
        if (ev.id) {
          const prior = interactionById.get(ev.id);
          if (prior && ev.status && ev.status !== 'pending') {
            // Resolved record → merge into the created row in place.
            prior.status = ev.status;
            if (ev.result !== undefined) prior.result = ev.result;
            if (ev.resolvedVia !== undefined) prior.resolvedVia = ev.resolvedVia;
            prior.resolvedAt = ev.ts;
            if (ev.text) prior.text = ev.text;
            continue;
          }
          const entity: HistoryEvent = {
            type: 'interaction',
            id: ev.id,
            kind: ev.kind,
            status: ev.status ?? 'pending',
            payload: ev.payload,
            result: ev.result,
            resolvedVia: ev.resolvedVia,
            text: ev.text ?? '',
            ts: ev.ts,
            turnIndex: Math.max(0, turnIndex),
          };
          events.push(entity);
          interactionById.set(ev.id, entity);
        } else {
          // Legacy line: {subtype, text} only.
          events.push({ type: 'interaction', subtype: ev.subtype, text: ev.text ?? '', ts: ev.ts, turnIndex: Math.max(0, turnIndex) });
        }
      }
    }

    if (events.length === 0) return null;
    return { sessionId, events };
  }

  /**
   * The first user message's text for a session, or null when there is none. Used to title a session
   * from its opening message (the left-rail display name for label-less sessions). Reads the JSONL and
   * stops at the first `user` line, so it does not parse the whole history.
   */
  async getFirstUserText(sessionId: string): Promise<string | null> {
    let raw: string;
    try {
      raw = await fs.readFile(sessionFile(sessionId), 'utf8');
    } catch {
      return null;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let ev: RawEvent;
      try { ev = JSON.parse(line) as RawEvent; } catch { continue; }
      if (ev.type === 'user') {
        const text = (ev.text ?? '').trim();
        return text.length ? text : null;
      }
    }
    return null;
  }

  async clear(sessionId: string): Promise<void> {
    // Wait for any in-flight append to this session, then remove the file.
    await (this.writeChains.get(sessionId) ?? Promise.resolve()).catch(() => {});
    this.writeChains.delete(sessionId);
    try { await fs.unlink(sessionFile(sessionId)); } catch { /* already gone */ }
  }

  /** Wait for all in-flight appends to land (graceful SIGTERM drain). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.writeChains.values()]);
  }
}

export const conversationHistory = new ConversationHistoryRepo();
