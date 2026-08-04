// input:  PI RPC lines, NormalizedEvents, and InjectionAckSink
// output: PI timers, context probe, EventQueue, steering, RPC parsing
// pos:    Small state primitives shared by PI session lifecycle code
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

import { createLogger } from '@core/log.js';
import type { AgentResult, AskUserQuestionInfo } from '@core/types/agent-types.js';
import type {
  AgentProcess, AgentProcessSpawner, InjectionAckSink, UserMessage,
} from '../types.js';
import type { NormalizedEvent } from '../normalize/event-types.js';
import { buildPrompt } from '../normalize/prompt-builder.js';

export const DEFAULT_PI_BINARY = 'pi';
export const CLOSE_EXIT_WAIT_MS = 5000;
export const SWITCH_SESSION_TIMEOUT_MS = 5000;
export const PI_IDLE_SESSION_TIMEOUT = 65 * 60 * 1000;
export const PI_TURN_IDLE_TIMEOUT = 60 * 60 * 1000;
export const PI_MAX_TIMEOUT = 30_000_000;
export const PI_CONTEXT_USAGE_TIMEOUT_MS = 1000;
export const PI_CONTEXT_USAGE_SAMPLE_MS = 2000;

const log = createLogger('pi-adapter');

export type SwitchResult = { ok: boolean; cancelled: boolean };

/** P1 (ii): PI's spawner is the same `AgentProcessSpawner` Claude takes, so the containment
 *  supervision handle survives the call instead of being discarded with the `ChildProcess`. */
export type SpawnFn = AgentProcessSpawner;

/** Test seam default. A benchmark spawn never reaches it — `assertBenchmarkSpawn` requires
 *  `spawnConfig.processSpawner`, so an unsupervised trial refuses rather than falling back here. */
export const defaultPiSpawn: SpawnFn = (command, args, options) => ({
  process: spawn(command, args, {
    ...options, stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams,
});

export interface PIAgentProcess extends AgentProcess {
  sendExtensionUiResponse(id: string, payload: Record<string, unknown>): void;
}

export interface PISessionOptions {
  sessionKey: string;
  sessionDir: string;
  /** Absolute CLI path frozen by a trial policy, or the bare `pi` name for daemon sessions. */
  command: string;
  cliArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawner: SpawnFn;
  /** Explicit delta policy; a trial passes the frozen value rather than reading watched settings. */
  streamDeltas: boolean;
  registry: Map<string, string>;
  registrySessionDir: string;
  onClose?: (sessionKey: string) => void;
}

export interface PendingPiTurn {
  resolve: (result: AgentResult) => void;
  reject: (error: Error) => void;
  planFilePath: string | null;
  askUserQuestions: AskUserQuestionInfo[];
  numTurns: number;
  totalCostUsd: number | null;
  promptDispatched: boolean;
  openingUserSeen: boolean;
  deferredCompletion: boolean;
}

export function buildPromptText(message: UserMessage): string {
  return buildPrompt(message.text, message.attachments ?? []);
}

export function parseRpcObject(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function isPIContextSampleBoundary(raw: Record<string, unknown> | null): boolean {
  return raw?.['type'] === 'message_update' || raw?.['type'] === 'message_end';
}

interface PendingContextProbe {
  id: string;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingTerminalProbe extends PendingContextProbe {
  terminal: NormalizedEvent;
}

/** Throttles live PI stats while independently correlating the final terminal-gating request. */
export class PIContextUsageProbe {
  private livePending: PendingContextProbe | null = null;
  private terminalPending: PendingTerminalProbe | null = null;
  private lastLiveRequestAt: number | null = null;
  private sequence = 0;

  constructor(
    private readonly write: (command: Record<string, unknown>) => void,
    private readonly emit: (event: NormalizedEvent) => void,
    private readonly timeoutMs = PI_CONTEXT_USAGE_TIMEOUT_MS,
    private readonly sampleMs = PI_CONTEXT_USAGE_SAMPLE_MS,
  ) {}

  requestSnapshot(): void {
    const now = Date.now();
    if (
      this.livePending ||
      (this.lastLiveRequestAt !== null && now - this.lastLiveRequestAt < this.sampleMs)
    ) return;
    const id = this.nextId();
    const timer = setTimeout(() => this.clearLive(id), this.timeoutMs);
    timer.unref?.();
    this.lastLiveRequestAt = now;
    this.livePending = { id, timer };
    try {
      this.write({ id, type: 'get_session_stats' });
    } catch {
      this.clearLive(id);
    }
  }

  deferTerminal(terminal: NormalizedEvent): void {
    this.releaseTerminal();
    const id = this.nextId();
    const timer = setTimeout(() => this.releaseTerminal(id), this.timeoutMs);
    timer.unref?.();
    this.terminalPending = { id, terminal, timer };
    try {
      this.write({ id, type: 'get_session_stats' });
    } catch {
      this.releaseTerminal(id);
    }
  }

  observe(raw: Record<string, unknown> | null): void {
    if (raw?.['type'] !== 'response' || raw['command'] !== 'get_session_stats') return;
    if (raw['id'] === this.livePending?.id) this.clearLive(this.livePending.id);
    if (raw['id'] === this.terminalPending?.id) this.releaseTerminal(this.terminalPending.id);
  }

  close(): void {
    if (this.livePending) clearTimeout(this.livePending.timer);
    if (this.terminalPending) clearTimeout(this.terminalPending.timer);
    this.livePending = null;
    this.terminalPending = null;
  }

  private nextId(): string {
    return `context-usage-${++this.sequence}`;
  }

  private clearLive(id: string): void {
    if (this.livePending?.id !== id) return;
    clearTimeout(this.livePending.timer);
    this.livePending = null;
  }

  private releaseTerminal(id?: string): void {
    const pending = this.terminalPending;
    if (!pending || (id !== undefined && pending.id !== id)) return;
    clearTimeout(pending.timer);
    this.terminalPending = null;
    this.emit(pending.terminal);
  }
}

export class EventQueue {
  private readonly pending: NormalizedEvent[] = [];
  private readonly waiters: ((result: IteratorResult<NormalizedEvent>) => void)[] = [];
  private closed = false;

  push(event: NormalizedEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.pending.push(event);
  }

  next(): Promise<IteratorResult<NormalizedEvent>> {
    const buffered = this.pending.shift();
    if (buffered) return Promise.resolve({ value: buffered, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
}

export interface PendingPiInjection {
  id: string;
  text: string;
  rejected: boolean;
}

/** FIFO steering lifecycle, including duplicate-safe deferred rejection delivery. */
export class PISteeringQueue {
  private sink: InjectionAckSink | null = null;
  private readonly pending: PendingPiInjection[] = [];
  private sequence = 0;

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  setSink(sink: InjectionAckSink): void {
    this.sink = sink;
  }

  clearSink(): void {
    this.sink = null;
  }

  begin(text: string): PendingPiInjection {
    const entry = { id: `pi-inject-${++this.sequence}`, text, rejected: false };
    this.pending.push(entry);
    return entry;
  }

  rollback(entry: PendingPiInjection): void {
    const index = this.pending.indexOf(entry);
    if (index !== -1) this.pending.splice(index, 1);
  }

  /** Mark a correlated failed injection; rejected duplicates seal only after earlier entries.
   *  Both RPC forms an injection can take (prompt+steer and the dedicated steer) are correlated. */
  rejectFromResponse(raw: Record<string, unknown>): boolean {
    const command = raw['command'];
    if (
      raw['type'] !== 'response' || raw['success'] !== false ||
      (command !== 'prompt' && command !== 'steer')
    ) {
      return false;
    }
    const entry = this.pending.find((item) => item.id === raw['id']);
    if (!entry) return false;
    entry.rejected = true;
    this.drainRejected();
    return true;
  }

  consumeNext(): void {
    this.drainRejected();
    const entry = this.pending.shift();
    if (entry) this.notifyDelivered(entry);
    this.drainRejected();
  }

  abandon(): void {
    for (const entry of this.pending.splice(0)) this.notifyUndelivered(entry);
  }

  private drainRejected(): void {
    while (this.pending[0]?.rejected) {
      const entry = this.pending.shift();
      if (entry) this.notifyUndelivered(entry);
    }
  }

  private notifyDelivered(entry: PendingPiInjection): void {
    try {
      this.sink?.onDelivered({ text: entry.text, foldedIntoTurn: true });
    } catch (err) {
      log.warn(`PI injection delivery sink failed: ${(err as Error).message}`);
    }
  }

  private notifyUndelivered(entry: PendingPiInjection): void {
    try {
      this.sink?.onUndelivered?.({ text: entry.text });
    } catch (err) {
      log.warn(`PI injection undelivered sink failed: ${(err as Error).message}`);
    }
  }
}
