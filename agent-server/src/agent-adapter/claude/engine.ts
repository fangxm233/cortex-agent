// input:  ClaudeSession, resolved EngineSpec, Claude turn callbacks
// output: ClaudeEngineSession: EngineSession over one ClaudeSession plus its RunEvent queue
// pos:    Claude backend's session surface: RunEvent runs over one ClaudeSession
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as path from 'path';
import type { AgentResult } from '@core/types/agent-types.js';
import { CAPABILITIES_BY_BACKEND, type Capability } from '../capabilities.js';
import { RunEventQueue, toRunEvent, type RunEvent } from '../run-events.js';
import type { NormalizedEvent } from '../normalize/event-types.js';
import type {
  AgentCompactResult, Backend, EngineRun, EngineSession, EngineSpec, InjectionAckSink, UserMessage,
} from '../types.js';
import {
  claudeTurnCallbacks,
  pushDerivedTurnEvents,
  type ClaudeTurnAccountingSource,
  type ClaudeTurnCallbacks,
} from './event-translator.js';

/**
 * The subset of `ClaudeSession` this engine drives, declared structurally so `adapter.ts` does not
 * have to widen its public surface by exporting the class. `ClaudeSession` satisfies it exactly.
 */
export interface ClaudeEngineSessionHost extends ClaudeTurnAccountingSource {
  readonly sessionId: string;
  sendMessage(text: string, options: ClaudeTurnCallbacks): Promise<AgentResult>;
  injectUserMessage(message: UserMessage): boolean;
  setInjectionAckSink(sink: InjectionAckSink): void;
  compact(): Promise<AgentCompactResult>;
  /** `ClaudeSession.close()` is synchronous (stdin end + grace timer); the engine wraps it. */
  close(): void;
  kill(): boolean;
  isAlive(): boolean;
}

/** One injection Cortex accepted into the current run, awaiting Claude's delivery/refusal ack. */
interface PendingInjection {
  id: string;
  text: string;
}

/** The pending injection whose text matches, removed FIFO; undefined for an unmatched ack.
 *  Same pattern as `pi/engine.ts:takePending`; P2.3d/P4.1 may unify the two. */
function takePending(pending: PendingInjection[], text: string): PendingInjection | undefined {
  const index = pending.findIndex((entry) => entry.text === text);
  if (index === -1) return undefined;
  return pending.splice(index, 1)[0];
}

/**
 * Claude's `EngineSession`. `run()` opens a RunEvent stream over the same `ClaudeSession` the
 * legacy `spawn()` path drives; the turn's normalized events arrive through the callback bag
 * (`claudeTurnCallbacks`), the derived accounting through `pushDerivedTurnEvents`, and the run adds
 * only the `session_started` and terminating `phase` bookkeeping. `cancel()` ends a run's stream,
 * never the pooled session.
 */
export class ClaudeEngineSession implements EngineSession {
  readonly backend: Backend = 'claude';
  /** The pool's reuse key. Claude compares compatibility structurally; this string serializes that
   *  exact predicate (`claudeCompatibilityIdentity`) so SessionEngines can compare plain strings. */
  readonly identity: string;
  readonly capabilities: ReadonlySet<Capability>;
  private readonly session: ClaudeEngineSessionHost;
  private readonly spec: EngineSpec;
  /** The run currently owning the session's single injection-ack slot (Claude serves one turn at a
   *  time). `steer()` targets it for id correlation and immediate refusals. */
  private active: { queue: RunEventQueue; pending: PendingInjection[] } | null = null;
  private injectionSeq = 0;
  /** Only the first run of a session emits `session_started`, matching `spawn()`'s `started` flag. */
  private started = false;
  /** Accepted and recorded; see `run()`. Claude continuation turns still travel the legacy
   *  `ContinuationSink` installed on the `spawn()` process, so this changes nothing yet (P4.1). */
  private lastAwaitBackground: 'none' | 'inline' | 'hold' = 'none';

  /** `identity` is passed in rather than computed here: it is derived from `adapter.ts`'s private
   *  `compatibilityFromOptions`, and importing that back would make `adapter.ts` ↔ `engine.ts` a
   *  runtime cycle. `ClaudeAdapter.open()` is the only constructor caller and supplies it. */
  constructor(session: ClaudeEngineSessionHost, spec: EngineSpec, identity: string) {
    this.session = session;
    this.spec = spec;
    this.identity = identity;
    // D9 declares capabilities per EngineSession. Claude's set happens to be backend-wide today (no
    // per-session narrowing exists), so this is a copy rather than a lookup: a future per-session
    // gate can mutate it without touching the shared matrix.
    this.capabilities = new Set(CAPABILITIES_BY_BACKEND.claude);
  }

  get backendSessionId(): string | null {
    return this.session.sessionId;
  }

  run(prompt: UserMessage, opts: { awaitBackground: 'none' | 'inline' | 'hold' }): EngineRun {
    const queue = new RunEventQueue();
    const pending: PendingInjection[] = [];
    this.active = { queue, pending };
    // The ack sink is a single session-level slot. In this slice `open()` always builds a fresh,
    // unpooled ClaudeSession, so no `spawn()` caller shares it; P2.3c pools the engine and must
    // arbitrate the slot then.
    this.session.setInjectionAckSink({
      onDelivered: ({ text, foldedIntoTurn }) => {
        const entry = takePending(pending, text);
        queue.push({
          type: 'injection_delivered',
          injectionId: entry?.id ?? this.nextInjectionId(),
          foldedIntoTurn,
        });
      },
      onUndelivered: ({ text }) => {
        const entry = takePending(pending, text);
        queue.push({
          type: 'injection_rejected',
          injectionId: entry?.id ?? this.nextInjectionId(),
          reason: 'undelivered',
        });
      },
    });
    // Accepted and recorded, but changes nothing yet: Claude's spontaneous continuation turns still
    // reach the caller through the legacy `ContinuationSink` that `AgentRun` installs on the
    // `spawn()` process. Routing them onto this run's stream is P4.1.
    this.lastAwaitBackground = opts.awaitBackground;
    if (!this.started) {
      // Claude has no turn-stream `session_started`; synthesize it exactly as `spawn().send()` does.
      queue.push(toRunEvent({ type: 'session_started', sessionId: this.session.sessionId }, 'foreground'));
      this.started = true;
    }

    const push = (event: NormalizedEvent) => queue.push(toRunEvent(event, 'foreground'));
    const files = (prompt.attachments || []).map((a) => ({
      mimetype: a.mimeType, localPath: a.path, name: path.basename(a.path),
    }));
    const result = this.driveTurn(prompt, files, push, queue);
    // The caller observes rejection through `EngineRun.result`; this only prevents an unhandled
    // rejection when a consumer reads `events` without awaiting `result`.
    result.catch(() => undefined);

    return {
      events: {
        [Symbol.asyncIterator]: (): AsyncIterator<RunEvent> => ({ next: () => queue.next() }),
      },
      result,
      // Ends this run, not the session: `spawn()`'s `AgentProcess.close()` does `stream.close()`
      // and deliberately not `session.close()`, so the pooled session serves the next run. Session
      // teardown goes through SessionEngines.close(key) / kill(key) (P2.3c).
      cancel: () => queue.close(),
    };
  }

  private async driveTurn(
    prompt: UserMessage,
    files: Array<{ mimetype: string; localPath: string; name: string }>,
    push: (event: NormalizedEvent) => void,
    queue: RunEventQueue,
  ): Promise<AgentResult> {
    try {
      const result = await this.session.sendMessage(prompt.text, {
        files,
        ...claudeTurnCallbacks(push),
      });
      pushDerivedTurnEvents(
        push, result, this.session, this.spec.flags.preserveUnreportedAccounting === true,
      );
      queue.push({
        type: 'phase', phase: 'done',
        pendingBackground: result.pendingBackgroundTasks ?? 0,
        undeliveredBackground: result.undeliveredBackgroundTasks ?? 0,
      });
      return result;
    } catch (err: any) {
      // Same suppression as `spawn().send()`: a cancelled turn is not an error worth surfacing.
      if (!err?.cancelled) {
        push({ type: 'error', message: String(err?.message ?? err), fatal: true });
      }
      queue.push({
        type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0,
      });
      throw err;
    } finally {
      queue.close();
    }
  }

  steer(msg: UserMessage): { accepted: boolean; injectionId?: string } {
    const injectionId = this.nextInjectionId();
    const accepted = this.session.injectUserMessage(msg);
    if (!accepted) {
      // A refused injection never reaches Claude's ack queue, so surface the rejection from here.
      this.active?.queue.push({ type: 'injection_rejected', injectionId, reason: 'refused' });
      return { accepted: false, injectionId };
    }
    this.active?.pending.push({ id: injectionId, text: msg.text });
    return { accepted: true, injectionId };
  }

  /** Claude exposes no extension-UI response channel (`AgentRun.respondToDialog` returns false for
   *  the same reason); do not invent one. */
  respondToDialog(_dialogId: string, _payload: Record<string, unknown>): boolean {
    return false;
  }

  compact(): Promise<AgentCompactResult> {
    return this.session.compact();
  }

  async close(): Promise<void> {
    this.session.close();
  }

  kill(): boolean {
    return this.session.kill();
  }

  /** The pool's liveness test: a session that self-terminated must not be reused. */
  isAlive(): boolean {
    return this.session.isAlive();
  }

  private nextInjectionId(): string {
    return `claude-run-inj-${++this.injectionSeq}`;
  }
}
