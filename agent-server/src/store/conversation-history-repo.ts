// input:  session JSONL, tool metadata, DEBUG sidecars, cache state
// output: history reads, compact projections, and remote device labels
// pos:    Canonical per-session transcript file store
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import { createReadStream, promises as fs } from 'fs';
import { createInterface } from 'node:readline';
import { STORE_DIR } from '@core/paths.js';
import {
  estimateCompactHistoryBytes,
  projectCompactHistory,
  projectSubagentHistory,
  type CompactConversationHistory,
  type SubagentConversationHistory,
} from './conversation-display-projection.js';
import {
  ConversationHistoryAccumulator,
  parseHistoryText,
  readHistoryAccumulator,
  readHistoryStream,
} from './conversation-history-reader.js';
import type { ChatNoticeLevel, NoticeAction } from '@core/types/agent-types.js';
import { parseTodoSnapshot, renderTodoProgress } from '../agent-adapter/normalize/todo.js';
import type { SubagentSpawnRef } from '../agent-adapter/normalize/event-types.js';

const HISTORY_DIR = path.join(STORE_DIR, 'conversation-history');

// --- Types ---

export type HistoryEventType = 'user' | 'assistant' | 'tool' | 'interaction';

/** Terminal state of one native subagent, as the backend's own task lifecycle reports it. */
export type SubagentEndStatus = 'completed' | 'failed' | 'killed';

export interface HistoryDebugDetails {
  /** Exact text handed to the adapter for this user turn. */
  agentMessage?: string;
  /** Opaque reference used to fetch one tool's full DEBUG details on demand. */
  toolRef?: string;
  /** Unabridged structured input for a tool call. */
  toolInput?: unknown;
  /** Full normalized result correlated to the tool call by backend tool-use id. */
  toolResult?: { content: string; isError: boolean };
  /** Lightweight warning derived without materializing a large tool result. */
  overCharacterThreshold?: true;
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
  /** Optional severity of an ask-user card ('info'|'warning'|'error') — absent = neutral look. */
  level?: 'info' | 'warning' | 'error';
  /** Present and false only on a non-blocking ask-user card: the agent kept running, so the
   *  session is not waiting on this answer. Absent = the default blocking ask. */
  blocking?: boolean;
  planContent?: string;
  planFilePath?: string | null;
}

export interface InteractionResult {
  answers?: Record<string, string>;
  feedback?: string;
}

export type DecisionActionKind = 'approve' | 'explain' | 'revise';

export interface HistoryDecisionAction {
  action: DecisionActionKind;
  message?: string;
  ts: string;
}

export interface RawDecisionItem {
  id: string;
  title: string;
  decision: string;
  context: string;
  reasoning: string;
}

export interface HistoryDecisionItem extends RawDecisionItem {
  actions: HistoryDecisionAction[];
}

/** A resolved history event (turnIndex derived at read time). */
export interface HistoryEvent {
  type: HistoryEventType;
  /** user / assistant message text (omitted for tool events). */
  text?: string;
  /** Semantic chat notice styling for system-authored assistant messages. */
  noticeLevel?: ChatNoticeLevel;
  /** Control offered by that notice; persisted so it survives a transcript reload. */
  noticeAction?: NoticeAction;
  /** tool name (tool events only). */
  toolName?: string;
  /** compact tool input summary (tool events only). */
  toolInput?: string;
  /** Remote execution target (remote tool events only). */
  toolDevice?: string;
  /** Native-subagent grouping key: the `Agent`/`Task` call's tool_use id. Set BOTH on that
   *  spawning call itself (which therefore anchors the group) and on every row the subagent
   *  produced under it. Absent = main agent. `sidechain` when the source attests a subagent
   *  without naming the parent (session-JSONL path) — those collapse into one anonymous group. */
  subagentId?: string;
  /** Children spawned by this main-agent tool row; each complete prompt is stored once here. */
  subagentSpawns?: SubagentSpawnRef[];
  /** Declared subagent type, e.g. `explore`. Reported on the subagent's own rows, not the anchor. */
  subagentType?: string;
  /** The spawning call's task description, as the CLI reports it. */
  subagentDescription?: string;
  /** The model that produced the row, as the subagent's own messages report it. Absent on the
   *  anchor (nothing has answered yet) and on rows read back from history written before this
   *  field existed — absent means unknown, never "same as the main agent". */
  subagentModel?: string;
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
  attachments?: { name: string; path: string; size: number; mimeType: string; type: 'image' | 'video' | 'file' | 'view' }[];
  /** Agent-announced decisions with append-only response actions folded in. */
  decisions?: HistoryDecisionItem[];
  /** Present on a user event that replaced an earlier message via edit+rewind. Derived on read
   *  from the preceding `edit-marker` raw line (the marker itself is never emitted). */
  edited?: { originalText: string; originalTs: string };
}

/** Raw line as persisted (no turnIndex — derived on read).
 *  `edit-marker` is a persistence-only line (message edit + rewind): appended right before the
 *  edited user event's re-send; on read it attaches to the NEXT user event as `edited` and is
 *  never emitted as an event itself.
 *  `subagent-end` is the same kind of line for a different fact: one native subagent reached a
 *  terminal state. It carries no prose, so it becomes no event either — on read it lands in
 *  `SessionHistory.subagentEnds`, which is what seals that subagent's block. */
export interface RawEvent {
  type: HistoryEventType | 'edit-marker' | 'debug-user-prompt' | 'debug-tool-result' | 'decision-action'
    | 'subagent-end';
  /** edit-marker lines only. */
  originalText?: string;
  /** edit-marker lines only. */
  originalTs?: string;
  text?: string;
  noticeLevel?: ChatNoticeLevel;
  noticeAction?: NoticeAction;
  toolName?: string;
  toolInput?: string;
  toolDevice?: string;
  subagentId?: string;
  subagentSpawns?: SubagentSpawnRef[];
  subagentType?: string;
  subagentDescription?: string;
  subagentModel?: string;
  /** `subagent-end` lines only: the terminal state reached by `subagentId`. */
  subagentEnded?: SubagentEndStatus;
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
  attachments?: { name: string; path: string; size: number; mimeType: string; type: 'image' | 'video' | 'file' | 'view' }[];
  decisions?: RawDecisionItem[];
  decisionId?: string;
  action?: DecisionActionKind;
  message?: string;
  /** Internal idempotency key for a recovered pending injection. Never emitted by getHistory. */
  sourceId?: string;
}

export interface SessionHistory {
  sessionId: string;
  events: HistoryEvent[];
  /** Internal committed pending ids used to suppress a cross-store handoff duplicate. */
  committedSourceIds?: string[];
  /** Subagents the backend reported terminal, keyed by the spawning `Agent`/`Task` tool-use id.
   *  Order-independent (a terminal state cannot be undone), which is why it rides beside the
   *  event list instead of inside it. */
  subagentEnds?: { id: string; status: SubagentEndStatus }[];
}

export interface HistoryReadOptions {
  /** False for chat-list reads: retain refs but skip full tool DEBUG inputs/results. */
  includeToolDebug?: boolean;
}

export interface ConversationHistoryRepoOptions {
  compactCacheEntries?: number;
  compactCacheBytes?: number;
  compactHistoryAccumulatorReader?: (
    sessionId: string,
    filePath: string,
    options: HistoryReadOptions,
  ) => Promise<ConversationHistoryAccumulator>;
}

export type { CompactConversationHistory, CompactConversationEvent, CompactSubagentSummary, SubagentConversationHistory } from './conversation-display-projection.js';

interface CompactCacheEntry {
  generation: number;
  bytes: number;
  accumulator: ConversationHistoryAccumulator;
  value: CompactConversationHistory;
}

interface ScannedCompactHistory {
  accumulator: ConversationHistoryAccumulator;
  value: CompactConversationHistory;
}

const DEFAULT_COMPACT_CACHE_ENTRIES = 32;
const DEFAULT_COMPACT_CACHE_BYTES = 32 * 1024 * 1024;

function estimateCacheEntryBytes(
  value: CompactConversationHistory,
  accumulator: ConversationHistoryAccumulator,
): number {
  const retained = accumulator.snapshot();
  const retainedBytes = retained ? Buffer.byteLength(JSON.stringify(retained), 'utf8') : 0;
  return retainedBytes + estimateCompactHistoryBytes(value);
}

function appendedCacheBytes(serializedLine: string): number {
  if (serializedLine.startsWith('{"type":"debug-tool-result"')) return 0;
  return Buffer.byteLength(serializedLine, 'utf8') + 256;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** How a caller names the subagent a row belongs to. Flattened onto the row by
 *  `subagentRowFields` so the persisted JSONL stays flat like every other field. */
export interface SubagentRowRef {
  id: string;
  type?: string | null;
  description?: string | null;
  model?: string | null;
}

function subagentRowFields(ref?: SubagentRowRef):
  { subagentId?: string; subagentType?: string; subagentDescription?: string; subagentModel?: string } {
  if (!ref) return {};
  return {
    subagentId: ref.id,
    ...(ref.type ? { subagentType: ref.type } : {}),
    ...(ref.description ? { subagentDescription: ref.description } : {}),
    ...(ref.model ? { subagentModel: ref.model } : {}),
  };
}

/** Compact, backend-agnostic one-line summary of a tool call's input for the history.
 *  Shared by the direct conversation path (agent-runner) and thread steps (thread-transcript)
 *  so both record identical tool-input summaries. */
const REMOTE_TOOL_NAMES = new Set([
  'remote_bash', 'remote_read', 'remote_write',
  'remote_edit', 'remote_glob', 'remote_grep',
]);

/** Device metadata used only to qualify remote tool labels in transcript UIs. */
export function toolDeviceForHistory(name: string, input: any): string | undefined {
  const rawName = name.split('__').at(-1)?.split('.').at(-1) ?? name;
  if (!REMOTE_TOOL_NAMES.has(rawName) || input == null || typeof input !== 'object') return undefined;
  const device = input.device;
  return typeof device === 'string' && device.trim() ? device.trim() : undefined;
}

export function summarizeToolInputForHistory(input: any): string {
  if (input == null || typeof input !== 'object') return '';
  // A task list has no string field worth picking below, so it used to fall through to
  // JSON.stringify and be cut off mid-object at 120 chars — the transcript chip showed a broken
  // JSON fragment. Render the progress instead.
  if (Array.isArray(input.todos)) {
    const snapshot = parseTodoSnapshot(input);
    if (snapshot) return renderTodoProgress(snapshot) || 'todos cleared';
  }
  const pick = (k: string) => (typeof input[k] === 'string' ? input[k] : undefined);
  const primary = pick('command') ?? pick('file_path') ?? pick('path') ?? pick('pattern') ?? pick('url') ?? pick('prompt') ?? pick('description') ?? pick('query');
  let s = primary ?? '';
  if (!s) {
    try { s = JSON.stringify(input); } catch { s = ''; }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

/** UUID sessionIds are filename-safe; sanitize defensively all the same. */
function sessionFilePath(historyDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(historyDir, `${safe}.jsonl`);
}

// --- Repo ---

function truncateLines(
  lines: string[],
  turnIndex: number,
): { kept: string[]; removed: { text: string; ts: string; attachments?: RawEvent['attachments'] } | null } {
  let userCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const ev = parseRawLine(lines[i]);
    if (ev?.type !== 'user') continue;
    if (userCount !== turnIndex) {
      userCount += 1;
      continue;
    }
    const keepEnd = markerAdjustedKeepEnd(lines, i);
    return {
      kept: lines.slice(0, keepEnd),
      removed: { text: ev.text ?? '', ts: ev.ts, ...(ev.attachments !== undefined ? { attachments: ev.attachments } : {}) },
    };
  }
  return { kept: lines, removed: null };
}

function markerAdjustedKeepEnd(lines: string[], cutAt: number): number {
  if (cutAt === 0) return 0;
  return parseRawLine(lines[cutAt - 1])?.type === 'edit-marker' ? cutAt - 1 : cutAt;
}

function parseRawLine(line: string): RawEvent | null {
  try { return JSON.parse(line) as RawEvent; } catch { return null; }
}

export class ConversationHistoryRepo {
  /** Per-session serial write chain — keeps concurrent appends from interleaving a line. */
  private writeChains = new Map<string, Promise<void>>();
  private generations = new Map<string, number>();
  private compactCache = new Map<string, CompactCacheEntry>();
  private compactCacheBytes = 0;
  private dirReady = false;
  private readonly compactCacheEntryLimit: number;
  private readonly compactCacheByteLimit: number;
  private readonly compactHistoryAccumulatorReader: NonNullable<ConversationHistoryRepoOptions['compactHistoryAccumulatorReader']>;

  constructor(
    private readonly historyDir: string = HISTORY_DIR,
    options: ConversationHistoryRepoOptions = {},
  ) {
    this.compactCacheEntryLimit = options.compactCacheEntries ?? DEFAULT_COMPACT_CACHE_ENTRIES;
    this.compactCacheByteLimit = options.compactCacheBytes ?? DEFAULT_COMPACT_CACHE_BYTES;
    this.compactHistoryAccumulatorReader = options.compactHistoryAccumulatorReader ?? readHistoryAccumulator;
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    await fs.mkdir(this.historyDir, { recursive: true });
    this.dirReady = true;
  }

  private currentGeneration(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0;
  }

  private bumpGeneration(sessionId: string): number {
    const next = this.currentGeneration(sessionId) + 1;
    this.generations.set(sessionId, next);
    return next;
  }

  private async awaitWriteChain(sessionId: string): Promise<void> {
    await (this.writeChains.get(sessionId) ?? Promise.resolve()).catch(() => {});
  }

  private dropCompactCache(sessionId: string): void {
    const cached = this.compactCache.get(sessionId);
    if (!cached) return;
    this.compactCacheBytes -= cached.bytes;
    this.compactCache.delete(sessionId);
  }

  private readCompactCache(sessionId: string): CompactConversationHistory | null | undefined {
    const cached = this.compactCache.get(sessionId);
    if (!cached) return undefined;
    if (cached.generation !== this.currentGeneration(sessionId)) {
      this.dropCompactCache(sessionId);
      return undefined;
    }
    this.compactCache.delete(sessionId);
    this.compactCache.set(sessionId, cached);
    return cached.value;
  }

  private markCompactCacheGeneration(sessionId: string, generation: number): void {
    const cached = this.compactCache.get(sessionId);
    if (!cached) return;
    cached.generation = generation;
    this.compactCache.delete(sessionId);
    this.compactCache.set(sessionId, cached);
  }

  private storeCompactCache(
    sessionId: string,
    value: CompactConversationHistory | null,
    generation: number,
    accumulator?: ConversationHistoryAccumulator,
    estimatedBytes?: number,
  ): void {
    if (value === null || !accumulator) return this.dropCompactCache(sessionId);
    const bytes = estimatedBytes ?? estimateCacheEntryBytes(value, accumulator);
    this.dropCompactCache(sessionId);
    if (bytes > this.compactCacheByteLimit) return;
    this.compactCache.set(sessionId, { generation, bytes, accumulator, value });
    this.compactCacheBytes += bytes;
    this.trimCompactCache();
  }

  private trimCompactCache(): void {
    while (
      this.compactCache.size > this.compactCacheEntryLimit
      || this.compactCacheBytes > this.compactCacheByteLimit
    ) {
      const oldest = this.compactCache.keys().next().value;
      if (!oldest) return;
      this.dropCompactCache(oldest);
    }
  }

  private updateCompactCacheAfterAppend(sessionId: string, serializedLine: string, generation: number): void {
    const cached = this.compactCache.get(sessionId);
    if (!cached) return;
    try {
      cached.accumulator.consumeLine(serializedLine.slice(0, -1));
      const history = cached.accumulator.snapshot();
      const bytes = cached.bytes + appendedCacheBytes(serializedLine);
      this.storeCompactCache(
        sessionId,
        history ? projectCompactHistory(history) : null,
        generation,
        cached.accumulator,
        bytes,
      );
    } catch {
      this.dropCompactCache(sessionId);
    }
  }

  private append(sessionId: string, ev: RawEvent): Promise<void> {
    const generation = this.bumpGeneration(sessionId);
    const serializedLine = JSON.stringify(ev) + '\n';
    const prev = this.writeChains.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      await this.ensureDir();
      try {
        await fs.appendFile(sessionFilePath(this.historyDir, sessionId), serializedLine, 'utf8');
      } catch (error) {
        this.dropCompactCache(sessionId);
        throw error;
      }
      this.updateCompactCacheAfterAppend(sessionId, serializedLine, generation);
    });
    this.writeChains.set(sessionId, next);
    return next;
  }

  private async readHistoryFile(sessionId: string): Promise<string | null> {
    try {
      return await fs.readFile(sessionFilePath(this.historyDir, sessionId), 'utf8');
    } catch {
      return null;
    }
  }

  private async readStreamHistory(sessionId: string): Promise<SessionHistory | null> {
    const filePath = sessionFilePath(this.historyDir, sessionId);
    try {
      return await readHistoryStream(sessionId, filePath, { includeToolDebug: false });
    } catch {
      return null;
    }
  }

  private async rewriteTruncatedSession(
    sessionId: string,
    turnIndex: number,
  ): Promise<{ text: string; ts: string; attachments?: RawEvent['attachments'] } | null> {
    const raw = await this.readHistoryFile(sessionId);
    if (raw === null) return null;
    const { kept, removed } = truncateLines(raw.split('\n').filter((line) => line.trim()), turnIndex);
    if (!removed) return null;
    await fs.writeFile(sessionFilePath(this.historyDir, sessionId), kept.length ? kept.join('\n') + '\n' : '', 'utf8');
    return removed;
  }

  private async scanCompactHistory(sessionId: string): Promise<ScannedCompactHistory | null> {
    const filePath = sessionFilePath(this.historyDir, sessionId);
    try {
      const accumulator = await this.compactHistoryAccumulatorReader(sessionId, filePath, { includeToolDebug: false });
      const history = accumulator.snapshot();
      return history ? { accumulator, value: projectCompactHistory(history) } : null;
    } catch {
      return null;
    }
  }

  private async stableCompactHistory(sessionId: string): Promise<CompactConversationHistory | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const generation = this.currentGeneration(sessionId);
      const history = await this.scanCompactHistory(sessionId);
      if (this.currentGeneration(sessionId) !== generation) {
        await this.awaitWriteChain(sessionId);
        const cached = this.readCompactCache(sessionId);
        if (cached !== undefined) return cached;
        continue;
      }
      this.storeCompactCache(sessionId, history?.value ?? null, generation, history?.accumulator);
      return history?.value ?? null;
    }
    await this.awaitWriteChain(sessionId);
    const cached = this.readCompactCache(sessionId);
    if (cached !== undefined) return cached;
    return this.serializedCompactHistory(sessionId);
  }

  private async serializedCompactHistory(sessionId: string): Promise<CompactConversationHistory | null> {
    let history: ScannedCompactHistory | null = null;
    const generation = this.currentGeneration(sessionId);
    const prev = this.writeChains.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => { history = await this.scanCompactHistory(sessionId); });
    this.writeChains.set(sessionId, next);
    await next;
    if (this.currentGeneration(sessionId) === generation) {
      this.storeCompactCache(sessionId, history?.value ?? null, generation, history?.accumulator);
    }
    return history?.value ?? null;
  }

  /** Append a user message — starts a new turn (turn boundaries are derived on read).
   *  An optional `ts` override lets the caller share a single timestamp with the
   *  EventBus event so the web UI's content-based de-dup produces identical keys. */
  appendUser(sessionId: string, opts: { text: string; ts?: string; attachments?: { name: string; path: string; size: number; mimeType: string; type: 'image' | 'video' | 'file' | 'view' }[]; agentMessage?: string; sourceId?: string }): Promise<void> {
    return this.append(sessionId, {
      type: 'user',
      text: opts.text,
      ts: opts.ts ?? nowIso(),
      attachments: opts.attachments,
      agentMessage: opts.agentMessage,
      sourceId: opts.sourceId,
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
  appendAssistant(sessionId: string, opts: { text: string; ts?: string; attachments?: { name: string; path: string; size: number; mimeType: string; type: 'image' | 'video' | 'file' | 'view' }[]; decisions?: RawDecisionItem[]; noticeLevel?: ChatNoticeLevel; noticeAction?: NoticeAction; subagent?: SubagentRowRef; subagentSpawns?: SubagentSpawnRef[] }): Promise<void> {
    return this.append(sessionId, {
      type: 'assistant', text: opts.text, ts: opts.ts ?? nowIso(),
      attachments: opts.attachments, noticeLevel: opts.noticeLevel, noticeAction: opts.noticeAction,
      ...(opts.decisions?.length ? { decisions: opts.decisions } : {}),
      ...(opts.subagentSpawns?.length ? { subagentSpawns: opts.subagentSpawns } : {}),
      ...subagentRowFields(opts.subagent),
    });
  }

  appendDecisionAction(sessionId: string, opts: { decisionId: string; action: DecisionActionKind; message?: string; ts?: string }): Promise<void> {
    return this.append(sessionId, {
      type: 'decision-action', decisionId: opts.decisionId, action: opts.action,
      ...(opts.message !== undefined ? { message: opts.message } : {}),
      ts: opts.ts ?? nowIso(),
    });
  }

  /** Append a tool call.
   *  An optional `ts` override lets the caller share a single timestamp with the EventBus event. */
  appendTool(sessionId: string, opts: { toolName: string; toolInput?: string; toolDevice?: string; ts?: string; toolUseId?: string; fullInput?: unknown; subagent?: SubagentRowRef; subagentSpawns?: SubagentSpawnRef[] }): Promise<void> {
    return this.append(sessionId, {
      type: 'tool',
      toolName: opts.toolName,
      toolInput: opts.toolInput ?? '',
      toolDevice: opts.toolDevice,
      ts: opts.ts ?? nowIso(),
      toolUseId: opts.toolUseId,
      fullInput: opts.fullInput,
      ...(opts.subagentSpawns?.length ? { subagentSpawns: opts.subagentSpawns } : {}),
      ...subagentRowFields(opts.subagent),
    });
  }

  /** Record that one native subagent reached a terminal state. Persisted rather than published
   *  live only, because it is the sole evidence a reader has that a subagent which ran BESIDE the
   *  main agent is over: the transcript alone cannot tell "still working" from "finished" for a
   *  backgrounded child, and a killed one leaves no other trace at all. Emits no transcript row. */
  appendSubagentEnd(sessionId: string, opts: { subagentId: string; status: SubagentEndStatus; ts?: string }): Promise<void> {
    return this.append(sessionId, {
      type: 'subagent-end',
      subagentId: opts.subagentId,
      subagentEnded: opts.status,
      ts: opts.ts ?? nowIso(),
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
  appendInteractionResolved(sessionId: string, opts: { id: string; status: InteractionStatus; result?: InteractionResult; resolvedVia: InteractionResolvedVia; text?: string; ts?: string }): Promise<void> {
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
    const generation = this.bumpGeneration(sessionId);
    let removed: { text: string; ts: string; attachments?: RawEvent['attachments'] } | null = null;
    const prev = this.writeChains.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      try {
        removed = await this.rewriteTruncatedSession(sessionId, turnIndex);
      } catch (error) {
        this.dropCompactCache(sessionId);
        throw error;
      }
      if (removed) this.dropCompactCache(sessionId);
      else this.markCompactCacheGeneration(sessionId, generation);
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
  async getHistory(
    sessionId: string,
    options: HistoryReadOptions = {},
  ): Promise<SessionHistory | null> {
    await this.awaitWriteChain(sessionId);
    const raw = await this.readHistoryFile(sessionId);
    return raw === null ? null : parseHistoryText(sessionId, raw, options);
  }

  async getCompactHistory(sessionId: string): Promise<CompactConversationHistory | null> {
    await this.awaitWriteChain(sessionId);
    const cached = this.readCompactCache(sessionId);
    return cached !== undefined ? cached : this.stableCompactHistory(sessionId);
  }

  async getSubagentHistory(sessionId: string, subagentId: string): Promise<SubagentConversationHistory> {
    await this.awaitWriteChain(sessionId);
    const history = await this.readStreamHistory(sessionId);
    const projected = projectSubagentHistory(history, subagentId);
    return { ...projected, sessionId };
  }

  /** Load one tool's lossless DEBUG payload without attaching every result to the transcript. */
  async getToolDebugDetails(
    sessionId: string,
    toolRef: string,
  ): Promise<HistoryDebugDetails | null> {
    await this.awaitWriteChain(sessionId);
    const stream = createReadStream(sessionFilePath(this.historyDir, sessionId), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let details: HistoryDebugDetails | null = null;
    try {
      for await (const line of lines) {
        if (!line.includes(toolRef)) continue;
        let event: RawEvent;
        try { event = JSON.parse(line) as RawEvent; } catch { continue; }
        if (event.toolUseId !== toolRef) continue;
        if (event.type === 'tool') {
          details = { ...(details ?? {}), toolRef, toolInput: event.fullInput };
        } else if (event.type === 'debug-tool-result') {
          return {
            ...(details ?? {}), toolRef,
            toolResult: { content: event.text ?? '', isError: event.isError === true },
          };
        }
      }
      return details;
    } catch {
      return null;
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  /** True when a recovered pending injection has already appended its committed user row. */
  async hasUserSourceId(sessionId: string, sourceId: string): Promise<boolean> {
    await this.awaitWriteChain(sessionId);
    const raw = await this.readHistoryFile(sessionId);
    if (raw === null) return false;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as RawEvent;
        if (event.type === 'user' && event.sourceId === sourceId) return true;
      } catch { /* malformed lines are ignored like getHistory */ }
    }
    return false;
  }

  /**
   * The first user message's text for a session, or null when there is none. Used to title a session
   * from its opening message (the left-rail display name for label-less sessions). Reads the JSONL and
   * stops at the first `user` line, so it does not parse the whole history.
   */
  async getFirstUserText(sessionId: string): Promise<string | null> {
    await this.awaitWriteChain(sessionId);
    const raw = await this.readHistoryFile(sessionId);
    if (raw === null) return null;
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
    const generation = this.bumpGeneration(sessionId);
    const prev = this.writeChains.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      this.dropCompactCache(sessionId);
      try { await fs.unlink(sessionFilePath(this.historyDir, sessionId)); } catch { /* already gone */ }
      this.markCompactCacheGeneration(sessionId, generation);
    });
    this.writeChains.set(sessionId, next);
    await next;
    if (this.writeChains.get(sessionId) === next) this.writeChains.delete(sessionId);
  }

  async clearBySessionIds(sessionIds: Iterable<string>): Promise<number> {
    let removed = 0;
    for (const sessionId of sessionIds) removed += await this.clearOneSession(sessionId);
    return removed;
  }

  private async clearOneSession(sessionId: string): Promise<number> {
    const generation = this.bumpGeneration(sessionId);
    let removed = 0;
    const prev = this.writeChains.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      this.dropCompactCache(sessionId);
      try {
        await fs.unlink(sessionFilePath(this.historyDir, sessionId));
        removed = 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.markCompactCacheGeneration(sessionId, generation);
    });
    this.writeChains.set(sessionId, next);
    await next;
    if (this.writeChains.get(sessionId) === next) this.writeChains.delete(sessionId);
    return removed;
  }

  /** Wait for all in-flight appends to land (graceful SIGTERM drain). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.writeChains.values()]);
  }
}

export const conversationHistory = new ConversationHistoryRepo();
