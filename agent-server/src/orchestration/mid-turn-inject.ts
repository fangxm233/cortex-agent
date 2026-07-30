// input:  live execution, runtime settings, pending/context seams
// output: durable injected turns, markers, and bounded continuations
// pos:    Busy-channel injection branch of AgentRunner.route
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

/**
 * Mid-turn user-message injection. A backend write only queues the message; its delivery ack may
 * fold into the current turn or open an otherwise-unobserved spontaneous turn. The adapter sinks
 * below cover both outcomes.
 *
 * Two-phase contract: persist active state before publishing a pending row, then on consumption (or
 * an undelivered/window seal) commit ledger + history, remove active state, and publish delivery.
 * Startup recovery applies the same idempotent commit to any active record left by process death.
 */

import { randomUUID } from 'node:crypto';
import { Capability, CAPABILITIES_BY_BACKEND } from '../agent-adapter/capabilities.js';
import type { Backend, ContinuationSink, InjectionAckSink, UserMessage } from '../agent-adapter/types.js';
import { SYNTHETIC_CALLBACK_SENDER } from '@platform/types.js';
import type { AttachmentMeta } from '@domain/ui-service/types.js';
import type { PendingInjectionRecord } from '@store/pending-injection-repo.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import type { ContextUsage } from '@core/types/agent-types.js';

const log = createLogger('mid-turn-inject');

/** Leak guard: a wedged process must not hold the daemon restart gate forever. */
function defaultMaxWaitMs(): number {
  return getSettings().injectWaitMaxS * 1000;
}

/** The subset of a pooled AgentProcess this path needs. */
export interface InjectableProcess {
  injectUserMessage?(message: UserMessage): boolean;
  setInjectionAckSink?(sink: InjectionAckSink): void;
  setContinuationSink?(sink: ContinuationSink): void;
}

/** The subset of a RunningExecution this path needs. */
export interface LiveExecutionLike {
  backend: string;
  agentProcess?: unknown;
}

export interface MidTurnInjectDeps {
  getLiveExecutions: (channel: string) => LiveExecutionLike[];
  /** Captured while the running turn still owns it, before a spontaneous turn starts. */
  getStreamingCallback: (channel: string) => ((text: string) => void) | null;
  appendAssistant: (sessionId: string, opts: { text: string; ts: string }) => void;
  appendTool: (sessionId: string, opts: { toolName: string; toolInput: string; ts: string; toolUseId?: string; fullInput?: unknown }) => void;
  appendToolResult?: (sessionId: string, opts: { toolUseId: string; content: string; isError: boolean }) => void;
  publishMessage: (ev: {
    sessionId: string; channel: string; role: 'user' | 'assistant' | 'tool'; text: string; ts: string;
    toolName?: string; toolInput?: string; attachments?: AttachmentMeta[]; pending?: boolean; pendingId?: string;
  }) => void;
  publishDelivered: (ev: { sessionId: string; channel: string; pendingId: string; messageTs: string; committedTs: string }) => void;
  publishStatus: (ev: { sessionId: string; channel: string; running: boolean }) => void;
  onContextUsage?: (sessionId: string, channel: string, usage: ContextUsage) => void;
  persistPending: (record: PendingInjectionRecord) => Promise<void>;
  commitPending: (record: PendingInjectionRecord) => Promise<{ committedTs: string }>;
  markPending?: (record: PendingInjectionRecord) => Promise<void>;
  unmarkPending?: (record: PendingInjectionRecord) => Promise<void>;
  createPendingId?: () => string;
  track: (delta: number) => void;
  now: () => string;
  summarizeToolInput?: (input: unknown) => string;
  captureDebug?: boolean;
  maxWaitMs?: number;
}

export interface MidTurnInjectCtx {
  channel: string;
  /** Stable Cortex track session id. Null (never-used channel) ⇒ nothing to surface against. */
  sessionId: string | null;
  sessionName?: string | null;
  profileName?: string | null;
  text: string;
  senderId: string;
  /** The inbound platform message id — the ledger turn's key. */
  messageId: string;
  attachments?: AttachmentMeta[];
}

/** Only plain human messages may fold into an in-flight turn. Commands and synthetic session
 * re-entry messages own separate dispatch semantics; edits kill the live execution before routing. */
export function isInjectableMessage(opts: { text: string; senderId: string }): boolean {
  const text = (opts.text ?? '').trim();
  if (!text) return false;
  if (text.startsWith('!')) return false;
  if (opts.senderId === SYNTHETIC_CALLBACK_SENDER) return false;
  return true;
}

/** True when the backend declares `Capability.MidTurnInject`. */
export function backendSupportsInject(backend: string): boolean {
  return !!CAPABILITIES_BY_BACKEND[backend as Backend]?.has(Capability.MidTurnInject);
}

/** First live execution on the channel that can actually take an injection. A Claude session in
 *  TUI mode declares the capability at backend level but exposes no `injectUserMessage`. */
function selectInjectTarget(execs: LiveExecutionLike[]): { proc: InjectableProcess; backend: string } | null {
  for (const exec of execs) {
    if (!backendSupportsInject(exec.backend)) continue;
    const proc = exec.agentProcess as InjectableProcess | undefined;
    if (proc && typeof proc.injectUserMessage === 'function') return { proc, backend: exec.backend };
  }
  return null;
}

/** An injected message written to the backend but not yet read by the model. */
interface PendingInjection {
  /** Matched against the backend lifecycle ack, which carries the original text. */
  text: string;
  /** Write-time ts — the key the pending row is showing under on every connected client. */
  ts: string;
  record: PendingInjectionRecord;
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
  /** Injected, echo not yet seen — keyed by text so an echo can find its own message's ts. */
  pending: PendingInjection[];
  /** Every busy-gate release still outstanding on this channel (each single-fire). */
  releases: Set<() => Promise<void>>;
  /** True once the spontaneous turn has been marked running, so we publish that edge only once. */
  continuationRunning: boolean;
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
  if (s && s.pending.length === 0 && s.releases.size === 0) channelStates.delete(channel);
}

class PendingLifecycle implements PendingInjection {
  readonly text: string;
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
    private readonly deps: MidTurnInjectDeps,
    private readonly state: ChannelInjectState,
  ) {
    this.text = record.text;
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

function buildPendingRecord(
  deps: MidTurnInjectDeps,
  ctx: MidTurnInjectCtx,
  sessionId: string,
  backend: string,
  ts: string,
): PendingInjectionRecord {
  return {
    id: deps.createPendingId?.() ?? randomUUID(),
    sessionId,
    channel: ctx.channel,
    messageId: ctx.messageId,
    sessionName: ctx.sessionName ?? null,
    backend,
    profileName: ctx.profileName ?? null,
    text: ctx.text,
    attachments: ctx.attachments,
    ...(deps.captureDebug ? { agentMessage: ctx.text } : {}),
    createdAt: ts,
  };
}

function armReleaseCap(deps: MidTurnInjectDeps, entry: PendingInjection): void {
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
  deps: MidTurnInjectDeps,
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
  });
  entry.activate();
}

/**
 * Try to deliver `ctx` into the turn already running on its channel.
 *
 * Returns true when the message was accepted by the backend — the caller must then NOT enqueue it.
 * Every rejection path (no live turn, incapable backend, non-plain message, backend refusal)
 * returns false and leaves no trace, so the caller falls through to today's queue behaviour.
 */
export async function tryInjectIntoLiveTurn(
  deps: MidTurnInjectDeps,
  ctx: MidTurnInjectCtx,
): Promise<boolean> {
  if (!isInjectableMessage(ctx) || !ctx.sessionId) return false;
  const target = selectInjectTarget(deps.getLiveExecutions(ctx.channel));
  if (!target) return false;
  if (!target.proc.injectUserMessage!({
    text: ctx.text,
    attachments: attachmentsForBackend(ctx.attachments),
  })) return false;

  const state = stateFor(ctx.channel);
  const record = buildPendingRecord(deps, ctx, ctx.sessionId, target.backend, deps.now());
  const entry = new PendingLifecycle(record, deps, state);
  deps.track(+1);
  state.pending.push(entry);
  state.releases.add(entry.release);
  registerSinks(deps, ctx.channel, ctx.sessionId, target.proc, state);
  await persistAndSurface(deps, entry);
  armReleaseCap(deps, entry);
  return true;
}

async function handleDelivered(
  state: ChannelInjectState,
  channel: string,
  text: string,
  foldedIntoTurn: boolean,
): Promise<void> {
  const index = state.pending.findIndex((entry) => entry.text === text);
  if (index === -1) return;
  const [entry] = state.pending.splice(index, 1);
  await entry.commit();
  if (foldedIntoTurn) await entry.release();
  else disposeIfIdle(channel);
}

async function handleUndelivered(state: ChannelInjectState, text: string): Promise<void> {
  await state.pending.find((entry) => entry.text === text)?.release();
}

function handleContinuationAssistant(
  deps: MidTurnInjectDeps,
  state: ChannelInjectState,
  sessionId: string,
  channel: string,
  streamAssistant: ((text: string) => void) | null,
  text: string,
): void {
  if (!text) return;
  if (!state.continuationRunning) {
    state.continuationRunning = true;
    deps.publishStatus({ sessionId, channel, running: true });
  }
  try { streamAssistant?.(text); }
  catch (error) { log.warn('injection stream callback threw:', (error as Error).message); }
  const ts = deps.now();
  deps.appendAssistant(sessionId, { text, ts });
  deps.publishMessage({ sessionId, channel, role: 'assistant', text, ts });
}

function handleContinuationTool(
  deps: MidTurnInjectDeps,
  sessionId: string,
  channel: string,
  name: string,
  input: unknown,
  toolUseId: string,
): void {
  const ts = deps.now();
  const toolInput = deps.summarizeToolInput?.(input) ?? '';
  deps.appendTool(sessionId, {
    toolName: name, toolInput, ts,
    ...(deps.captureDebug ? { toolUseId, fullInput: input } : {}),
  });
  deps.publishMessage({ sessionId, channel, role: 'tool', text: '', toolName: name, toolInput, ts });
}

async function handleContinuationResult(
  deps: MidTurnInjectDeps,
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

/** Register session-scoped, last-registration-wins lifecycle sinks. */
function registerSinks(
  deps: MidTurnInjectDeps,
  channel: string,
  sessionId: string,
  proc: InjectableProcess,
  state: ChannelInjectState,
): void {
  const stream = deps.getStreamingCallback(channel);
  proc.setInjectionAckSink?.({
    onDelivered: ({ text, foldedIntoTurn }) => handleDelivered(state, channel, text, foldedIntoTurn),
    onUndelivered: ({ text }) => handleUndelivered(state, text),
  });
  proc.setContinuationSink?.({
    onAssistantText: (text) => handleContinuationAssistant(deps, state, sessionId, channel, stream, text),
    onToolUse: (name, input, toolUseId) => handleContinuationTool(deps, sessionId, channel, name, input, toolUseId),
    onToolResult: (toolUseId, content, isError) => {
      if (deps.captureDebug) deps.appendToolResult?.(sessionId, { toolUseId, content, isError });
    },
    onContextUsage: (usage) => deps.onContextUsage?.(sessionId, channel, usage),
    onResult: () => handleContinuationResult(deps, state, sessionId, channel),
  });
}

/** Map web attachment metadata onto the backend's UserMessage attachment shape. */
function attachmentsForBackend(attachments?: AttachmentMeta[]): UserMessage['attachments'] {
  if (!attachments?.length) return undefined;
  return attachments.map((a) => ({ mimeType: a.mimeType, path: a.path }));
}

/** Test hook: drop all per-channel injection state. */
export const _test = {
  reset(): void { channelStates.clear(); },
};
