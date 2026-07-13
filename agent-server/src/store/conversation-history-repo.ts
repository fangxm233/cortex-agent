// input:  store/conversation-history/<sessionId>.jsonl, sessionId, message events
// output: ConversationHistoryRepo — Cortex's own backend-independent conversation history
// pos:    One append-only JSONL file PER SESSION under a directory (keyed by sessionId,
//         persistent across reconnects). Records the FULL conversation — user inputs, every
//         assistant message, every tool call — as the canonical display source for the TUI.
//         Backend-agnostic: fed from the orchestration layer's unified callbacks.
//
//         Why per-session JSONL (not one big JSON file): writes are pure O(1) appends — a
//         single line per event, no read-modify-rewrite of the whole store. Turn grouping
//         and streaming-growth dedup are computed at READ time, so the write path never has
//         to inspect prior state. Scales to thousands of sessions / long histories.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import { promises as fs } from 'fs';
import { STORE_DIR } from '@core/paths.js';

const HISTORY_DIR = path.join(STORE_DIR, 'conversation-history');

// --- Types ---

export type HistoryEventType = 'user' | 'assistant' | 'tool';

/** A resolved history event (turnIndex derived at read time). */
export interface HistoryEvent {
  type: HistoryEventType;
  /** user / assistant message text (omitted for tool events). */
  text?: string;
  /** tool name (tool events only). */
  toolName?: string;
  /** compact tool input summary (tool events only). */
  toolInput?: string;
  ts: string;
  /** Groups events under the user turn that triggered them. */
  turnIndex: number;
}

/** Raw line as persisted (no turnIndex — derived on read). */
interface RawEvent {
  type: HistoryEventType;
  text?: string;
  toolName?: string;
  toolInput?: string;
  ts: string;
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

  /** Append a user message — starts a new turn (turn boundaries are derived on read). */
  appendUser(sessionId: string, opts: { text: string }): Promise<void> {
    return this.append(sessionId, { type: 'user', text: opts.text, ts: nowIso() });
  }

  /** Append an assistant message. Streaming partials are collapsed at read time. */
  appendAssistant(sessionId: string, opts: { text: string }): Promise<void> {
    return this.append(sessionId, { type: 'assistant', text: opts.text, ts: nowIso() });
  }

  /** Append a tool call. */
  appendTool(sessionId: string, opts: { toolName: string; toolInput?: string }): Promise<void> {
    return this.append(sessionId, { type: 'tool', toolName: opts.toolName, toolInput: opts.toolInput ?? '', ts: nowIso() });
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
    let turnIndex = -1;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let ev: RawEvent;
      try { ev = JSON.parse(line) as RawEvent; } catch { continue; }

      if (ev.type === 'user') {
        turnIndex++;
        events.push({ type: 'user', text: ev.text ?? '', ts: ev.ts, turnIndex });
      } else if (ev.type === 'assistant') {
        const tIdx = Math.max(0, turnIndex);
        const last = events[events.length - 1];
        const text = ev.text ?? '';
        if (last && last.type === 'assistant' && last.turnIndex === tIdx && typeof last.text === 'string' && isPrefixRelated(last.text, text)) {
          if (text.length >= last.text.length) { last.text = text; last.ts = ev.ts; }
        } else {
          events.push({ type: 'assistant', text, ts: ev.ts, turnIndex: tIdx });
        }
      } else if (ev.type === 'tool') {
        events.push({ type: 'tool', toolName: ev.toolName ?? '', toolInput: ev.toolInput ?? '', ts: ev.ts, turnIndex: Math.max(0, turnIndex) });
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
