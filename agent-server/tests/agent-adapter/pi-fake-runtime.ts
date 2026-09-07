// input:  PiSessionRequest and PISession callbacks, scripted answers from a test
// output: FakeRuntime: an in-memory PI runtime handle whose calls a test can inspect and drive
// pos:    Shared stand-in for the PI SDK behind PIAdapter/PISession tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type {
  PiAgentSessionLike, PiRawEvent, PiRuntimeCallbacks, PiRuntimeFactory, PiRuntimeHandle,
} from '../../src/agent-adapter/pi/runtime.js';
import type { PiSessionRequest } from '../../src/agent-adapter/pi/session-options.js';
import type { CodexQuotaReading } from '../../src/domain/costs/codex-quota.js';

type SessionStats = ReturnType<PiAgentSessionLike['getSessionStats']>;
type CompactionResult = Awaited<ReturnType<PiAgentSessionLike['compact']>>;
type PromptOptions = NonNullable<Parameters<PiAgentSessionLike['prompt']>[1]>;

export type FakeSessionCall =
  | { kind: 'prompt'; text: string; options: PromptOptions | undefined }
  | { kind: 'steer'; text: string }
  | { kind: 'abort' }
  | { kind: 'compact' }
  | { kind: 'switch'; path: string }
  | { kind: 'dispose' };

export interface FakeRuntimeOptions {
  sessionId?: string;
  /** Transcript path reported by the fake session; null mirrors an in-memory PI session. */
  sessionFile?: string | null;
  /** Session stats returned by getSessionStats(); defaults to a small, context-less reading. */
  stats?: Partial<SessionStats>;
  /** Result of compact(); an Error makes compact() reject with it. */
  compact?: CompactionResult | Error;
  /** Answer of switchSession(); an Error makes it reject. */
  switchResult?: { cancelled: boolean } | Error;
  /** Keep every prompt() pending in `heldPrompts` until the test settles it (mirrors PI, whose
   *  prompt() resolves only when the run is over). */
  holdPrompts?: boolean;
}

export interface HeldPrompt {
  text: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

const DEFAULT_STATS: SessionStats = {
  sessionFile: undefined,
  sessionId: 'fake-session',
  userMessages: 0,
  assistantMessages: 0,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
};

/**
 * One fake PI runtime. Every call the session makes is recorded; a test drives the session by
 * emitting PI events through `emit` (the same records PI's AgentSession.subscribe delivers).
 * `prompt` and `steer` resolve immediately unless the test queued a rejection.
 */
export class FakeRuntime implements PiRuntimeHandle {
  readonly request: PiSessionRequest;
  readonly callbacks: PiRuntimeCallbacks;
  readonly calls: FakeSessionCall[] = [];
  readonly uiResponses: { id: string; payload: Record<string, unknown> }[] = [];
  readonly session: PiAgentSessionLike;
  sessionId: string;
  sessionFile: string | null;
  isStreaming = false;
  stats: SessionStats;
  compactResult: CompactionResult | Error;
  switchResult: { cancelled: boolean } | Error;
  disposed = false;
  /** Errors handed to the next prompt()/steer() calls, in order. */
  readonly promptRejections: Error[] = [];
  readonly steerRejections: Error[] = [];
  /** Prompts still pending under `holdPrompts`, in call order. */
  readonly heldPrompts: HeldPrompt[] = [];
  /** When set, switchSession() waits for it before answering (a switch still in flight). */
  switchGate: Promise<void> | null = null;
  private readonly holdPrompts: boolean;
  /** Ids a respondToUi() call should refuse (simulating a dialog that is no longer waiting). */
  readonly unknownUiIds = new Set<string>();
  private readonly callWaiters: { kind: FakeSessionCall['kind']; resolve: (call: FakeSessionCall) => void }[] = [];

  constructor(request: PiSessionRequest, callbacks: PiRuntimeCallbacks, options: FakeRuntimeOptions = {}) {
    this.request = request;
    this.callbacks = callbacks;
    this.sessionId = options.sessionId ?? `fake-${request.sessionKey}`;
    this.sessionFile = options.sessionFile === undefined
      ? `${request.sessionDir}/${this.sessionId}.jsonl`
      : options.sessionFile;
    this.stats = { ...DEFAULT_STATS, sessionId: this.sessionId, ...options.stats };
    this.compactResult = options.compact ?? { summary: 'compacted', firstKeptEntryId: 'e1', tokensBefore: 0 };
    this.switchResult = options.switchResult ?? { cancelled: false };
    this.holdPrompts = options.holdPrompts ?? false;
    const self = this;
    this.session = {
      get sessionId() { return self.sessionId; },
      get sessionFile() { return self.sessionFile ?? undefined; },
      get isStreaming() { return self.isStreaming; },
      prompt: (text, options) => {
        self.record({ kind: 'prompt', text, options });
        const rejection = self.promptRejections.shift();
        if (rejection) return Promise.reject(rejection);
        if (!self.holdPrompts) return Promise.resolve();
        return new Promise<void>((resolve, reject) => { self.heldPrompts.push({ text, resolve, reject }); });
      },
      steer: (text) => {
        self.record({ kind: 'steer', text });
        const rejection = self.steerRejections.shift();
        return rejection ? Promise.reject(rejection) : Promise.resolve();
      },
      abort: async () => { self.record({ kind: 'abort' }); },
      compact: async () => {
        self.record({ kind: 'compact' });
        if (self.compactResult instanceof Error) throw self.compactResult;
        return self.compactResult;
      },
      getSessionStats: () => ({ ...self.stats, sessionFile: self.sessionFile ?? undefined, sessionId: self.sessionId }),
    };
  }

  private record(call: FakeSessionCall): void {
    this.calls.push(call);
    for (const waiter of this.callWaiters.splice(0)) {
      if (waiter.kind === call.kind) waiter.resolve(call);
      else this.callWaiters.push(waiter);
    }
  }

  /**
   * Resolves with the next call of `kind` the session makes (or the last one already recorded when
   * `past` is true). PISession hands the prompt to PI only after its runtime resolved, so a test
   * that emits events for a turn awaits `nextCall('prompt')` first.
   */
  nextCall<K extends FakeSessionCall['kind']>(kind: K): Promise<Extract<FakeSessionCall, { kind: K }>> {
    return new Promise((resolve) => {
      this.callWaiters.push({ kind, resolve: (call) => resolve(call as Extract<FakeSessionCall, { kind: K }>) });
    });
  }

  respondToUi(id: string, payload: Record<string, unknown>): boolean {
    if (this.unknownUiIds.has(id)) return false;
    this.uiResponses.push({ id, payload });
    return true;
  }

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    this.record({ kind: 'switch', path: sessionPath });
    if (this.switchGate) await this.switchGate;
    if (this.switchResult instanceof Error) throw this.switchResult;
    return this.switchResult;
  }

  async dispose(): Promise<void> {
    this.record({ kind: 'dispose' });
    this.disposed = true;
  }

  /** Deliver one PI session event to the PISession. */
  emit(event: PiRawEvent): void {
    this.callbacks.onEvent(event);
  }

  emitQuota(reading: CodexQuotaReading): void {
    this.callbacks.onProviderQuota?.(reading);
  }

  prompts(): string[] {
    return this.calls.flatMap((call) => (call.kind === 'prompt' ? [call.text] : []));
  }

  steers(): string[] {
    return this.calls.flatMap((call) => (call.kind === 'steer' ? [call.text] : []));
  }

  // --- Scripted PI runs -----------------------------------------------------------------------

  /** PI echoed a user message into the loop: the opening prompt first, then each queued steer. */
  emitUserMessage(text: string): void {
    this.emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } });
  }

  /** PI entered its agent loop for the prompt it was just handed. */
  emitAgentStart(): void {
    this.isStreaming = true;
    this.emit({ type: 'agent_start' });
    this.emit({ type: 'turn_start' });
    this.emit({ type: 'message_start', message: { role: 'user', content: [] } });
  }

  /** One assistant text message, as PI streams it (optionally as several deltas). */
  emitAssistantText(text: string, opts: { responseId?: string; deltas?: string[] } = {}): void {
    const responseId = opts.responseId ?? 'msg-1';
    const message = { role: 'assistant', responseId, content: [{ type: 'text', text }] };
    this.emit({ type: 'message_start', message: { role: 'assistant', responseId, content: [] } });
    for (const delta of opts.deltas ?? [text]) {
      this.emit({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'text_delta', delta, contentIndex: 0 },
      });
    }
    this.emit({ type: 'message_end', message });
  }

  emitToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>, result: string, isError = false): void {
    this.emit({ type: 'tool_execution_start', toolCallId, toolName, args });
    this.emit({
      type: 'tool_execution_end',
      toolCallId,
      toolName,
      result: { content: [{ type: 'text', text: result }] },
      isError,
    });
  }

  /** PI's run ended; `agent_settled` is what closes the Cortex turn. */
  emitAgentEnd(opts: {
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total: number } };
    provider?: string;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    settle?: boolean;
  } = {}): void {
    const message: Record<string, unknown> = {
      role: 'assistant',
      provider: opts.provider ?? 'fake',
      model: opts.model ?? 'fake-model',
      stopReason: opts.stopReason ?? 'stop',
      ...(opts.usage ? { usage: opts.usage } : {}),
      ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
    };
    this.emit({ type: 'turn_end' });
    this.emit({ type: 'agent_end', messages: [message] });
    this.isStreaming = false;
    if (opts.settle !== false) this.emit({ type: 'agent_settled' });
  }

  /** A whole run: loop start, one assistant message, run end. */
  emitSimpleTurn(text = 'ok', opts: Parameters<FakeRuntime['emitAgentEnd']>[0] = {}): void {
    this.emitAgentStart();
    this.emitAssistantText(text);
    this.emitAgentEnd(opts);
  }
}

export interface FakeRuntimeFactoryOptions extends FakeRuntimeOptions {
  /** Reject runtime creation with this error instead of producing a runtime. */
  fail?: Error;
  /** Per-runtime session ids, by creation order; falls back to `fake-<sessionKey>`. */
  sessionIds?: string[];
  /** Hold creation until the returned promise resolves (tests that act before `ready`). */
  gate?: Promise<void>;
  /** Observe or customise each runtime as it is created. */
  onCreate?: (runtime: FakeRuntime) => void;
}

export interface FakeRuntimeFactory {
  factory: PiRuntimeFactory;
  /** Every request the adapter resolved, in spawn order (one per runtime created). */
  requests: PiSessionRequest[];
  runtimes: FakeRuntime[];
  /** Resolves once the runtime for creation `index` (0-based) exists. */
  runtime(index?: number): Promise<FakeRuntime>;
}

/**
 * A PiRuntimeFactory that hands PISession a FakeRuntime per creation. Tests read the resolved
 * request (env, model, MCP servers...) off `requests` and drive the session through `runtimes`.
 */
export function makeFakeRuntimeFactory(options: FakeRuntimeFactoryOptions = {}): FakeRuntimeFactory {
  const requests: PiSessionRequest[] = [];
  const runtimes: FakeRuntime[] = [];
  const waiters: { index: number; resolve: (runtime: FakeRuntime) => void }[] = [];
  const factory: PiRuntimeFactory = async (request, callbacks) => {
    const index = requests.length;
    requests.push(request);
    if (options.gate) await options.gate;
    if (options.fail) throw options.fail;
    const runtime = new FakeRuntime(request, callbacks, {
      ...options,
      sessionId: options.sessionIds?.[index] ?? options.sessionId,
    });
    options.onCreate?.(runtime);
    runtimes.push(runtime);
    for (const waiter of waiters.splice(0)) {
      if (waiter.index < runtimes.length) waiter.resolve(runtimes[waiter.index]);
      else waiters.push(waiter);
    }
    return runtime;
  };
  return {
    factory,
    requests,
    runtimes,
    runtime: (index = 0) => {
      if (runtimes[index]) return Promise.resolve(runtimes[index]);
      return new Promise((resolve) => waiters.push({ index, resolve }));
    },
  };
}

/** Collect a process's normalized events until its stream ends. */
export async function collectEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of events) out.push(event);
  return out;
}
