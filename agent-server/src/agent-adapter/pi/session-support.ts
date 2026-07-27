// input:  PI RPC lines, NormalizedEvents, and InjectionAckSink
// output: PI timers, context probe, EventQueue, steering, RPC parsing
// pos:    Small state primitives shared by PI session lifecycle code
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ChildProcess, SpawnOptions } from 'child_process';

import { createLogger } from '@core/log.js';
import type { AgentResult, AskUserQuestionInfo } from '@core/types/agent-types.js';
import type { AgentProcess, InjectionAckSink } from '../types.js';
import type { NormalizedEvent } from '../normalize/event-types.js';

export const DEFAULT_PI_BINARY = 'pi';
export const CLOSE_EXIT_WAIT_MS = 5000;
export const SWITCH_SESSION_TIMEOUT_MS = 5000;
export const PI_IDLE_SESSION_TIMEOUT = 65 * 60 * 1000;
export const PI_TURN_IDLE_TIMEOUT = 60 * 60 * 1000;
export const PI_MAX_TIMEOUT = 30_000_000;
export const PI_CONTEXT_USAGE_TIMEOUT_MS = 1000;

const log = createLogger('pi-adapter');

export type SwitchResult = { ok: boolean; cancelled: boolean };
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface PIAgentProcess extends AgentProcess {
  sendExtensionUiResponse(id: string, payload: Record<string, unknown>): void;
}

export interface PISessionOptions {
  sessionKey: string;
  sessionDir: string;
  cliArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawner: SpawnFn;
  registry: Map<string, string>;
  registrySessionDir: string;
  onClose?: (sessionKey: string) => void;
}

export interface PendingPiTurn {
  resolve: (result: AgentResult) => void;
  reject: (error: Error) => void;
  planFilePath: string | null;
  askUserQuestions: AskUserQuestionInfo[];
  rateLimited: boolean;
  numTurns: number;
  totalCostUsd: number | null;
  promptDispatched: boolean;
  openingUserSeen: boolean;
  deferredCompletion: boolean;
}

export function parseRpcObject(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

interface PendingContextProbe {
  id: string;
  terminal: NormalizedEvent;
  timer: ReturnType<typeof setTimeout>;
}

/** Correlates PI's optional end-of-turn stats response without letting telemetry hang a turn. */
export class PIContextUsageProbe {
  private pending: PendingContextProbe | null = null;
  private sequence = 0;

  constructor(
    private readonly write: (command: Record<string, unknown>) => void,
    private readonly emit: (event: NormalizedEvent) => void,
    private readonly timeoutMs = PI_CONTEXT_USAGE_TIMEOUT_MS,
  ) {}

  deferTerminal(terminal: NormalizedEvent): void {
    this.release();
    const id = `context-usage-${++this.sequence}`;
    const timer = setTimeout(() => this.release(id), this.timeoutMs);
    timer.unref?.();
    this.pending = { id, terminal, timer };
    try {
      this.write({ id, type: 'get_session_stats' });
    } catch {
      this.release(id);
    }
  }

  observe(raw: Record<string, unknown> | null): void {
    if (
      raw?.['type'] === 'response' && raw['command'] === 'get_session_stats' &&
      raw['id'] === this.pending?.id
    ) this.release(this.pending.id);
  }

  close(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private release(id?: string): void {
    const pending = this.pending;
    if (!pending || (id !== undefined && pending.id !== id)) return;
    clearTimeout(pending.timer);
    this.pending = null;
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

  /** Mark a correlated failed prompt; rejected duplicates seal only after earlier entries. */
  rejectFromResponse(raw: Record<string, unknown>): boolean {
    if (raw['type'] !== 'response' || raw['command'] !== 'prompt' || raw['success'] !== false) {
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
