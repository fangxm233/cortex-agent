// input:  NormalizedEvents, InjectionAckSink, user messages
// output: PI timers, EventQueue, steering queue, turn accumulator
// pos:    Small state primitives shared by PI session lifecycle code
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createLogger } from '@core/log.js';
import type { AgentResult, AskUserQuestionInfo } from '@core/types/agent-types.js';
import type { AgentProcess, InjectionAckSink, UserMessage } from '../types.js';
import type { NormalizedEvent } from '../normalize/event-types.js';
import { buildPrompt } from '../normalize/prompt-builder.js';

const log = createLogger('pi-adapter');

export const PI_IDLE_SESSION_TIMEOUT = 65 * 60 * 1000;
export const PI_TURN_IDLE_TIMEOUT = 60 * 60 * 1000;
/** Minimum spacing between live context-usage samples while a turn streams. */
export const PI_CONTEXT_USAGE_SAMPLE_MS = 2000;

export type SwitchResult = { ok: boolean; cancelled: boolean };

export interface PIAgentProcess extends AgentProcess {
  sendExtensionUiResponse(id: string, payload: Record<string, unknown>): void;
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

  /** Mark an injection PI refused; rejected duplicates seal only after earlier entries. */
  reject(entry: PendingPiInjection): boolean {
    if (!this.pending.includes(entry)) return false;
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
