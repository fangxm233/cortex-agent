// input:  RunEvent stream from a run + resolved session/agent identifiers
// output: RunObserver that appends transcript rows and publishes session events; the mid-turn
//         injection ledger that persists injected messages and commits them from run events
// pos:    orchestration — the one history+publish observer every run surface shares, replacing
//         the four hand-wired copies (agent-runner foreground, the two background surfaces,
//         mid-turn-inject). The pending-injection two-phase persistence lives here.

import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { sessionTodos } from '@core/session-todos.js';
import type {
  ChatNoticeLevel, ContextUsage, NoticeAction, SessionContextUsage, TodoSnapshot,
} from '@core/types/agent-types.js';
import { conversationHistory, summarizeToolInputForHistory, toolDeviceForHistory } from '@store/conversation-history-repo.js';
import type { SubagentRowRef } from '@store/conversation-history-repo.js';
import type { PendingInjectionRecord } from '@store/pending-injection-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import type { AttachmentMeta } from '@domain/ui-service/types.js';
import {
  subagentSpawnFromAttribution, subagentSpawnsFromToolCall,
} from '../agent-adapter/normalize/event-types.js';
import type { SubagentSpawnRef, ToolUseSubagent } from '../agent-adapter/normalize/event-types.js';
import type { RunEvent, RunPhase } from '../domain/runs/events.js';
import type { RunObserver } from '../domain/runs/request.js';
import type { AgentRun } from '../domain/runs/run.js';
import {
  publishSessionContextUsage, publishSessionDebugUpdated, publishSessionMessage, publishSessionTodos,
} from './session-events.js';
import { subagentPayloadFields, subagentRowRef } from './subagent-rows.js';

const log = createLogger('transcript-sink');

/** Set a session's persisted context snapshot, then publish the identical live value. */
export interface SessionContextUsagePersistenceDeps {
  now: () => string;
  update: (sessionName: string, updates: { contextUsage: SessionContextUsage }) => Promise<void>;
  publish: (snapshot: { sessionId: string; channel: string } & SessionContextUsage) => void;
}

const defaultContextUsagePersistence: SessionContextUsagePersistenceDeps = {
  now: () => new Date().toISOString(),
  update: (sessionName, updates) => sessionStore.updateSession(sessionName, updates),
  publish: publishSessionContextUsage,
};

/** Persist first, then publish the identical live snapshot so query and event clients converge. */
export async function persistSessionContextUsage(
  input: { sessionName: string; sessionId: string; channel: string; usage: ContextUsage },
  deps: SessionContextUsagePersistenceDeps = defaultContextUsagePersistence,
): Promise<void> {
  const contextUsage = { ...input.usage, updatedAt: deps.now() };
  await deps.update(input.sessionName, { contextUsage });
  deps.publish({ sessionId: input.sessionId, channel: input.channel, ...contextUsage });
}

/** Side-effect seams. Production callers omit these; the defaults bind the real store/publishers. */
export interface TranscriptSinkDeps {
  appendTool: (sessionId: string, opts: Parameters<typeof conversationHistory.appendTool>[1]) => Promise<void>;
  appendToolResult: (sessionId: string, opts: Parameters<typeof conversationHistory.appendToolResult>[1]) => Promise<void>;
  appendSubagentEnd: (sessionId: string, opts: Parameters<typeof conversationHistory.appendSubagentEnd>[1]) => Promise<void>;
  appendAssistant: (sessionId: string, opts: Parameters<typeof conversationHistory.appendAssistant>[1]) => Promise<void>;
  setTodos: (sessionId: string, snapshot: TodoSnapshot) => void;
  publishMessage: typeof publishSessionMessage;
  publishTodos: typeof publishSessionTodos;
  publishDebugUpdated: typeof publishSessionDebugUpdated;
  persistContextUsage: typeof persistSessionContextUsage;
}

const DEFAULT_DEPS: TranscriptSinkDeps = {
  appendTool: (sessionId, opts) => conversationHistory.appendTool(sessionId, opts),
  appendToolResult: (sessionId, opts) => conversationHistory.appendToolResult(sessionId, opts),
  appendSubagentEnd: (sessionId, opts) => conversationHistory.appendSubagentEnd(sessionId, opts),
  appendAssistant: (sessionId, opts) => conversationHistory.appendAssistant(sessionId, opts),
  setTodos: (sessionId, snapshot) => sessionTodos.set(sessionId, snapshot),
  publishMessage: publishSessionMessage,
  publishTodos: publishSessionTodos,
  publishDebugUpdated: publishSessionDebugUpdated,
  persistContextUsage: persistSessionContextUsage,
};

export interface TranscriptSinkOptions {
  /** Stable Cortex tracking id every row and event is keyed on. */
  sessionId: string;
  /** Conduit the session events are published to. */
  channel: string;
  /** Session name the context-usage store update is keyed on. */
  sessionName: string;
  /** Whether to persist DEBUG-only tool details (toolUseId / fullInput / tool result). */
  debug: boolean;
  /** Platform status/streaming callback for non-subagent assistant text. Subagent prose is
   *  withheld from chat surfaces and only persisted with its attribution. */
  onAssistantMessage?: (text: string) => void;
  /** Refresh the platform status line from a fresh task-list snapshot. */
  onTodoUpdate?: (snapshot: TodoSnapshot) => void;
  /** Drain a block's pending token deltas before its authoritative message is persisted. */
  flushDelta?: (blockId: string) => void;
  /** Test seam; production callers omit it. */
  deps?: Partial<TranscriptSinkDeps>;
}

/** Fire-and-forget history append; never let a logging write break the turn. */
function recordHistory(p: Promise<unknown>, onPersisted?: () => void): void {
  void p.then(() => onPersisted?.()).catch((e) => log.error('conversation-history write failed:', (e as Error).message));
}

/**
 * Build the transcript observer. It turns each `RunEvent` into the exact history append and
 * `publishSession*` side effects the per-surface closures used to perform, so every run surface can
 * share one copy. Nothing here is backend-specific: phases do not change the persisted shape.
 */
export function createTranscriptSink(opts: TranscriptSinkOptions): RunObserver {
  const { sessionId, channel, sessionName, debug } = opts;
  const deps: TranscriptSinkDeps = { ...DEFAULT_DEPS, ...opts.deps };

  function persistToolUse(
    name: string, input: unknown, toolUseId: string, subagent?: ToolUseSubagent,
  ): void {
    const toolInput = summarizeToolInputForHistory(input);
    const toolDevice = toolDeviceForHistory(name, input);
    const ts = new Date().toISOString();
    const ref = subagent ? subagentRowRef(subagent) : undefined;
    const attributedSpawn = subagent ? subagentSpawnFromAttribution(subagent) : null;
    const subagentSpawns = attributedSpawn
      ? [attributedSpawn]
      : subagent ? [] : subagentSpawnsFromToolCall(name, input, toolUseId);
    const legacyAnchor = !subagent && name !== 'agent' && subagentSpawns.length === 1
      ? { id: subagentSpawns[0].id }
      : undefined;
    const rowRef = ref ?? legacyAnchor;
    recordHistory(
      deps.appendTool(sessionId, {
        toolName: name,
        toolInput,
        ...(toolDevice ? { toolDevice } : {}),
        ts,
        ...(rowRef ? { subagent: rowRef } : {}),
        ...(subagentSpawns.length ? { subagentSpawns } : {}),
        ...(debug ? { toolUseId, fullInput: input } : {}),
      }),
      debug ? () => deps.publishDebugUpdated({ sessionId, channel }) : undefined,
    );
    deps.publishMessage({
      sessionId, channel, role: 'tool', text: '', toolName: name, toolInput, ts,
      ...(toolDevice ? { toolDevice } : {}),
      ...(subagentSpawns.length ? { subagentSpawns } : {}),
      ...subagentPayloadFields(rowRef),
    });
  }

  function persistSubagentEnd(
    parentToolUseId: string, status: 'completed' | 'failed' | 'killed',
  ): void {
    if (!parentToolUseId) return;
    const ts = new Date().toISOString();
    recordHistory(deps.appendSubagentEnd(sessionId, {
      subagentId: parentToolUseId, status, ts,
    }));
    deps.publishMessage({
      sessionId, channel, role: 'assistant', text: '', ts,
      subagentId: parentToolUseId, subagentEnded: status,
    });
  }

  function persistAssistant(
    text: string, blockId: string | undefined,
    noticeLevel: ChatNoticeLevel | undefined, noticeAction: NoticeAction | undefined,
    subagent: ToolUseSubagent | undefined, phase: RunPhase,
  ): void {
    // Drain this block's preview FIRST: the authoritative message must never be overtaken by
    // a delta still sitting in the coalescer, or the UI would replace the row and then append
    // a stale fragment to it.
    if (blockId) opts.flushDelta?.(blockId);
    const ref = subagent ? subagentRowRef(subagent) : undefined;
    const attributedSpawn = subagent ? subagentSpawnFromAttribution(subagent) : null;
    // A subagent's prose is working notes addressed to its parent, not an answer addressed to
    // the user. Chat platforms get the live counter on the spawning call's trace line instead;
    // the full text stays in the transcript, where it can be grouped.
    //
    // Only the foreground turn streams to the platform callback. A background turn's prose belongs
    // to whichever surface is holding the turn open (the platform hold merges it into the held
    // reply, the web one publishes it as new session messages); streaming it from here
    // too would post it twice. The ROW is written either way — that is what this sink is for.
    if (!ref && phase === 'foreground') opts.onAssistantMessage?.(text);
    if (!text) return;
    const ts = new Date().toISOString();
    recordHistory(deps.appendAssistant(sessionId, {
      text, ts, noticeLevel, noticeAction,
      ...(ref ? { subagent: ref } : {}),
      ...(attributedSpawn ? { subagentSpawns: [attributedSpawn] } : {}),
    }));
    deps.publishMessage({
      sessionId, channel, role: 'assistant', text, ts,
      ...(blockId ? { blockId } : {}),
      ...(noticeLevel ? { noticeLevel } : {}),
      ...(noticeAction ? { noticeAction } : {}),
      ...(attributedSpawn ? { subagentSpawns: [attributedSpawn] } : {}),
      ...subagentPayloadFields(ref),
    });
  }

  return {
    onEvent(event: RunEvent): void | Promise<void> {
      switch (event.type) {
        case 'tool_use':
          persistToolUse(event.name, event.input, event.toolUseId, event.subagent);
          return;
        case 'tool_result':
          if (!debug) return;
          recordHistory(
            deps.appendToolResult(sessionId, {
              toolUseId: event.toolUseId, content: event.content, isError: !event.ok,
            }),
            () => deps.publishDebugUpdated({ sessionId, channel }),
          );
          return;
        case 'subagent_end':
          persistSubagentEnd(event.parentToolUseId, event.status);
          return;
        case 'todo_update':
          deps.setTodos(sessionId, event.snapshot);
          deps.publishTodos({ sessionId, channel, snapshot: event.snapshot });
          opts.onTodoUpdate?.(event.snapshot);
          return;
        case 'assistant_text':
          persistAssistant(
            event.text, event.blockId, event.noticeLevel, event.noticeAction, event.subagent,
            event.phase,
          );
          return;
        case 'context_usage':
          return deps.persistContextUsage({
            sessionName, sessionId, channel,
            usage: {
              usedTokens: event.usedTokens, contextWindow: event.contextWindow,
              percent: event.percent, accuracy: event.accuracy,
            },
          });
        default:
          return;
      }
    },
  };
}

// ══ mid-turn injection ledger ═══════════════════════════════════════════════
//
// Moved here from `orchestration/mid-turn-inject.ts`. A backend write only queues an
// injected message; its delivery ack may fold into the current turn or open an otherwise-unobserved
// spontaneous turn. The ledger owns the durable two-phase persistence (persist pending → publish
// a provisional row → commit history+ledger exactly once) and consumes the run's
// `injection_delivered` / `injection_rejected` events plus background-phase continuation events.
//
// `AgentRun` installs the backend `InjectionAckSink` and owns the process's single
// `BackgroundTurnSink`; the ledger never touches either. It is only fed RunEvents.

/** Side-effect seams for the injection ledger, bound by `buildInjectDeps` in production. */
export interface InjectionLedgerDeps {
  /** Captured while the running turn still owns it, before a spontaneous turn starts. */
  getStreamingCallback: (channel: string) => ((text: string) => void) | null;
  appendAssistant: (sessionId: string, opts: {
    text: string; ts: string; subagent?: SubagentRowRef; subagentSpawns?: SubagentSpawnRef[];
  }) => void;
  appendTool: (sessionId: string, opts: {
    toolName: string; toolInput: string; toolDevice?: string; ts: string; toolUseId?: string;
    fullInput?: unknown; subagent?: SubagentRowRef; subagentSpawns?: SubagentSpawnRef[];
  }) => void;
  appendToolResult?: (sessionId: string, opts: {
    toolUseId: string; content: string; isError: boolean;
  }) => void;
  publishMessage: (ev: {
    sessionId: string; channel: string; role: 'user' | 'assistant' | 'tool'; text: string; ts: string;
    toolName?: string; toolInput?: string; toolDevice?: string; attachments?: AttachmentMeta[];
    pending?: boolean; pendingId?: string; subagentId?: string; subagentSpawns?: SubagentSpawnRef[];
    subagentType?: string; subagentDescription?: string; subagentModel?: string;
  }) => void;
  publishDelivered: (ev: {
    sessionId: string; channel: string; pendingId: string; messageTs: string; committedTs: string;
  }) => void;
  publishStatus: (ev: { sessionId: string; channel: string; running: boolean }) => void;
  onContextUsage?: (sessionId: string, channel: string, usage: ContextUsage) => void;
  persistPending: (record: PendingInjectionRecord) => Promise<void>;
  commitPending: (record: PendingInjectionRecord) => Promise<{ committedTs: string }>;
  markPending?: (record: PendingInjectionRecord) => Promise<void>;
  unmarkPending?: (record: PendingInjectionRecord) => Promise<void>;
  track: (delta: number) => void;
  now: () => string;
  summarizeToolInput?: (input: unknown) => string;
  captureDebug?: boolean;
  maxWaitMs?: number;
}

/** Leak guard: a wedged process must not hold the daemon restart gate forever. */
function defaultMaxWaitMs(): number {
  return getSettings().injectWaitMaxS * 1000;
}

/** An injected message written to the backend but not yet read by the model. */
interface PendingInjection {
  record: PendingInjectionRecord;
  /** Write-time ts — the key the pending row is showing under on every connected client. */
  ts: string;
  /** Persisted + published gate. Early backend acks wait here so event order stays pending→delivered. */
  activate: () => void;
  /** Move it into the conversation record (history + ledger turn + the delivered event). Single-fire. */
  commit: () => Promise<boolean>;
  mark: () => void;
  release: () => Promise<void>;
  isReleased: () => boolean;
}

/** Per-channel bookkeeping for messages injected into the live turn but not yet replied to. */
interface ChannelInjectState {
  pending: PendingInjection[];
  /** Every busy-gate release still outstanding on this channel (each single-fire). */
  releases: Set<() => Promise<void>>;
  /** True once the spontaneous turn has been marked running, so we publish that edge only once. */
  continuationRunning: boolean;
  /** The run-event subscription that drives phase two while this channel has live injections. */
  unsubscribe?: () => void;
}

const channelStates = new Map<string, ChannelInjectState>();

function stateFor(channel: string): ChannelInjectState {
  let s = channelStates.get(channel);
  if (!s) {
    s = { pending: [], releases: new Set(), continuationRunning: false };
    channelStates.set(channel, s);
  }
  return s;
}

function disposeIfIdle(channel: string): void {
  const s = channelStates.get(channel);
  if (s && s.pending.length === 0 && s.releases.size === 0) {
    s.unsubscribe?.();
    channelStates.delete(channel);
  }
}

class PendingLifecycle implements PendingInjection {
  readonly ts: string;
  private activeResolve!: () => void;
  private readonly active: Promise<void>;
  private commitPromise: Promise<boolean> | null = null;
  private releasePromise: Promise<void> | null = null;
  private markerPromise: Promise<void> = Promise.resolve();
  private markerStarted = false;
  private markerCleared = false;

  constructor(
    readonly record: PendingInjectionRecord,
    private readonly deps: InjectionLedgerDeps,
    private readonly state: ChannelInjectState,
  ) {
    this.ts = record.createdAt;
    this.active = new Promise<void>((resolve) => { this.activeResolve = resolve; });
  }

  activate = (): void => { this.activeResolve(); };
  isReleased = (): boolean => this.releasePromise !== null;

  mark = (): void => {
    if (this.markerStarted || !this.deps.markPending) return;
    this.markerStarted = true;
    try {
      this.markerPromise = this.deps.markPending(this.record).catch(() => {});
    } catch {
      this.markerPromise = Promise.resolve();
    }
  };

  private clearMarker(): void {
    if (!this.markerStarted || this.markerCleared || !this.deps.unmarkPending) return;
    this.markerCleared = true;
    this.markerPromise = this.markerPromise
      .then(() => this.deps.unmarkPending!(this.record))
      .catch(() => {});
  }

  commit = (): Promise<boolean> => {
    if (!this.commitPromise) {
      const attempt = this.commitOnce();
      this.commitPromise = attempt;
      void attempt.then((committed) => {
        if (!committed && this.commitPromise === attempt) this.commitPromise = null;
      });
    }
    return this.commitPromise;
  };

  private async commitOnce(): Promise<boolean> {
    await this.active;
    try {
      const { committedTs } = await this.deps.commitPending(this.record);
      this.clearMarker();
      this.deps.publishDelivered({
        sessionId: this.record.sessionId, channel: this.record.channel,
        pendingId: this.record.id, messageTs: this.ts, committedTs,
      });
      return true;
    } catch (error) {
      log.error(`Failed to commit pending injection ${this.record.id}: ${(error as Error).message}`);
      return false;
    }
  }

  release = (): Promise<void> => {
    if (!this.releasePromise) this.releasePromise = this.releaseOnce();
    return this.releasePromise;
  };

  private async releaseOnce(): Promise<void> {
    this.state.releases.delete(this.release);
    const index = this.state.pending.findIndex((entry) => entry.record.id === this.record.id);
    if (index !== -1) this.state.pending.splice(index, 1);
    await this.commit();
    this.deps.track(-1);
    disposeIfIdle(this.record.channel);
  }
}

function armReleaseCap(deps: InjectionLedgerDeps, entry: PendingInjection): void {
  const capMs = deps.maxWaitMs ?? defaultMaxWaitMs();
  if (capMs <= 0) return;
  const timer = setTimeout(() => {
    if (!entry.isReleased()) {
      log.warn(`Injected message on ${entry.record.channel} got no reply within the cap — releasing the busy gate`);
    }
    void entry.release();
  }, capMs);
  timer.unref?.();
}

async function persistAndSurface(
  deps: InjectionLedgerDeps,
  entry: PendingInjection,
): Promise<void> {
  try {
    await deps.persistPending(entry.record);
  } catch (error) {
    // The backend already accepted the message, so falling through to the normal queue would send
    // it twice. Degrade to phase two instead: commit it to the transcript and let the delivered
    // event trigger refetch. Never advertise a provisional row that cannot survive a restart.
    log.error(`Failed to persist pending injection ${entry.record.id}: ${(error as Error).message}`);
    entry.activate();
    await entry.commit();
    return;
  }
  entry.mark();
  deps.publishMessage({
    sessionId: entry.record.sessionId, channel: entry.record.channel, role: 'user',
    text: entry.record.text, ts: entry.ts, attachments: entry.record.attachments,
    pending: true, pendingId: entry.record.id,
    // Carried onto the provisional row too: without it a backgrounded agent's result would flash
    // as a full user bubble for as long as the model takes to read it, then collapse to a hint.
    ...(entry.record.systemOrigin ? { systemOrigin: entry.record.systemOrigin } : {}),
  });
  entry.activate();
}

/**
 * Register one accepted injection with the ledger (phase one). The caller must already have passed
 * `record.id` to `run.steer()`; the run's `injection_delivered` / `injection_rejected` event will
 * carry it back here to run phase two.
 */
export async function beginInjection(
  deps: InjectionLedgerDeps,
  record: PendingInjectionRecord,
): Promise<void> {
  const state = stateFor(record.channel);
  const entry = new PendingLifecycle(record, deps, state);
  deps.track(+1);
  state.pending.push(entry);
  state.releases.add(entry.release);
  await persistAndSurface(deps, entry);
  armReleaseCap(deps, entry);
}

async function handleDelivered(
  channel: string,
  injectionId: string,
  foldedIntoTurn: boolean,
): Promise<void> {
  const state = channelStates.get(channel);
  if (!state) return;
  const index = state.pending.findIndex((entry) => entry.record.id === injectionId);
  if (index === -1) return;
  const [entry] = state.pending.splice(index, 1);
  await entry.commit();
  if (foldedIntoTurn) await entry.release();
  else disposeIfIdle(channel);
}

async function handleUndelivered(channel: string, injectionId: string): Promise<void> {
  const state = channelStates.get(channel);
  if (!state) return;
  await state.pending.find((entry) => entry.record.id === injectionId)?.release();
}

function handleContinuationAssistant(
  deps: InjectionLedgerDeps,
  state: ChannelInjectState,
  sessionId: string,
  channel: string,
  streamAssistant: ((text: string) => void) | null,
  text: string,
  subagent?: ToolUseSubagent,
): void {
  if (!text) return;
  if (!state.continuationRunning) {
    state.continuationRunning = true;
    deps.publishStatus({ sessionId, channel, running: true });
  }
  // Streamed text is the reply the user reads, so a subagent's working notes stay out of it —
  // but they are still recorded, tagged, so the transcript can fold them into that subagent's
  // block rather than showing them as the agent speaking a turn later.
  const ref = subagent ? subagentRowRef(subagent) : undefined;
  const attributedSpawn = subagent ? subagentSpawnFromAttribution(subagent) : null;
  if (!ref) {
    try { streamAssistant?.(text); }
    catch (error) { log.warn('injection stream callback threw:', (error as Error).message); }
  }
  const ts = deps.now();
  deps.appendAssistant(sessionId, {
    text, ts, ...(ref ? { subagent: ref } : {}),
    ...(attributedSpawn ? { subagentSpawns: [attributedSpawn] } : {}),
  });
  deps.publishMessage({
    sessionId, channel, role: 'assistant', text, ts,
    ...(attributedSpawn ? { subagentSpawns: [attributedSpawn] } : {}),
    ...subagentPayloadFields(ref),
  });
}

function handleContinuationTool(
  deps: InjectionLedgerDeps,
  sessionId: string,
  channel: string,
  name: string,
  input: unknown,
  toolUseId: string,
  subagent?: ToolUseSubagent,
): void {
  const ts = deps.now();
  const toolInput = deps.summarizeToolInput?.(input) ?? '';
  const toolDevice = toolDeviceForHistory(name, input);
  const ref = subagent ? subagentRowRef(subagent) : undefined;
  const attributedSpawn = subagent ? subagentSpawnFromAttribution(subagent) : null;
  const subagentSpawns = attributedSpawn
    ? [attributedSpawn]
    : subagent ? [] : subagentSpawnsFromToolCall(name, input, toolUseId);
  const legacyAnchor = !subagent && name !== 'agent' && subagentSpawns.length === 1
    ? { id: subagentSpawns[0].id }
    : undefined;
  const rowRef = ref ?? legacyAnchor;
  deps.appendTool(sessionId, {
    toolName: name, toolInput, ts,
    ...(toolDevice ? { toolDevice } : {}),
    ...(rowRef ? { subagent: rowRef } : {}),
    ...(subagentSpawns.length ? { subagentSpawns } : {}),
    ...(deps.captureDebug ? { toolUseId, fullInput: input } : {}),
  });
  deps.publishMessage({
    sessionId, channel, role: 'tool', text: '', toolName: name, toolInput, ts,
    ...(toolDevice ? { toolDevice } : {}),
    ...(subagentSpawns.length ? { subagentSpawns } : {}),
    ...subagentPayloadFields(rowRef),
  });
}

async function handleContinuationResult(
  deps: InjectionLedgerDeps,
  state: ChannelInjectState,
  sessionId: string,
  channel: string,
): Promise<void> {
  state.continuationRunning = false;
  deps.publishStatus({ sessionId, channel, running: false });
  await Promise.all([...state.releases].map((release) => release()));
  state.pending = [];
  disposeIfIdle(channel);
}

/**
 * Adapt a run's `RunEvent` fan-out onto the ledger: injection acks drive phase two, background
 * continuation events become transcript rows for the injected turn. Foreground events are ignored —
 * they belong to the surface's own sink.
 */
export function createInjectionObserver(
  deps: InjectionLedgerDeps,
  channel: string,
  sessionId: string,
  /** The run whose background rows a hold may already own — see `AgentRun.backgroundTranscriptOwned`.
   *  Absent (tests, or an injection with no live run) means the ledger is the only writer. */
  run?: Pick<AgentRun, 'backgroundTranscriptOwned'>,
): RunObserver {
  const stream = deps.getStreamingCallback(channel);
  /** Exactly one observer persists the background turn. When a background hold has claimed it, the
   *  ledger still commits its injections but writes no transcript rows — otherwise a session that is
   *  both held and injected into would append every continuation row twice. */
  const ownsRows = (): boolean => run?.backgroundTranscriptOwned !== true;
  return {
    onEvent(event: RunEvent): void | Promise<void> {
      switch (event.type) {
        case 'injection_delivered':
          return handleDelivered(channel, event.injectionId, event.foldedIntoTurn);
        case 'injection_rejected':
          return handleUndelivered(channel, event.injectionId);
        case 'assistant_text':
          if (event.phase !== 'background' || !ownsRows()) return;
          return handleContinuationAssistant(deps, stateFor(channel), sessionId, channel, stream, event.text, event.subagent);
        case 'tool_use':
          if (event.phase !== 'background' || !ownsRows()) return;
          return handleContinuationTool(deps, sessionId, channel, event.name, event.input, event.toolUseId, event.subagent);
        case 'tool_result':
          if (event.phase !== 'background' || !ownsRows()) return;
          if (deps.captureDebug) {
            deps.appendToolResult?.(sessionId, {
              toolUseId: event.toolUseId, content: event.content, isError: !event.ok,
            });
          }
          return;
        case 'context_usage':
          if (event.phase !== 'background' || !ownsRows()) return;
          deps.onContextUsage?.(sessionId, channel, {
            usedTokens: event.usedTokens, contextWindow: event.contextWindow,
            percent: event.percent, accuracy: event.accuracy,
          });
          return;
        case 'background_result':
          return handleContinuationResult(deps, stateFor(channel), sessionId, channel);
        default:
          return;
      }
    },
  };
}

/** Subscribe the ledger to `run` once per channel; the subscription is released when it idles. */
export function ensureInjectionObserver(
  deps: InjectionLedgerDeps,
  channel: string,
  sessionId: string,
  run: AgentRun,
): void {
  const state = stateFor(channel);
  if (state.unsubscribe) return;
  state.unsubscribe = run.subscribe(createInjectionObserver(deps, channel, sessionId, run));
}

/** Test hook: drop all per-channel injection state. */
export function resetInjectionLedger(): void {
  channelStates.clear();
}
