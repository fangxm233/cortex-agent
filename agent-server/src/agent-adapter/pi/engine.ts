// input:  PISession, resolved PiSessionRequest, PI normalized events
// output: PIEngineSession: EngineSession over one PISession plus its RunEvent queue
// pos:    PI backend's session surface: RunEvent runs plus the transitional legacy AgentProcess
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { AgentResult } from '@core/types/agent-types.js';
import { CAPABILITIES_BY_BACKEND, type Capability } from '../capabilities.js';
import { RunEventQueue, toRunEvent, type RunEvent } from '../run-events.js';
import type {
  AgentCompactResult, Backend, EngineRun, EngineSession, UserMessage,
} from '../types.js';
import { turnStreamIterable, type PISession } from './pi-session.js';
import { sessionIdentity, type PiSessionRequest } from './session-options.js';
import type { EventQueue, PIAgentProcess, SwitchResult } from './session-support.js';

/** Hooks the owning pool injects when it opens a session. Optional so a bare `open()` used by
 *  tests and P2.4 consumers can construct an engine without an owner. */
export interface PIEngineOpenHooks {
  /** Forwarded to `PISession.onClose`: the session terminated itself (start failure, idle timeout). */
  onSelfClose?: (sessionKey: string, session: unknown) => void;
  /** The pool evicts this engine after a successful `kill()` (the legacy AgentProcess path). */
  onEvict?: (session: PIEngineSession) => void;
  /** Registry + disk lookup the legacy spawn path uses to resolve the transcript to send into. */
  resolveSessionPath?: (sessionId: string) => string | null;
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** One injection Cortex accepted into the current run, awaiting PI's delivery/refusal ack. */
interface PendingInjection {
  id: string;
  text: string;
}

/** The pending injection whose text matches, removed FIFO; undefined for an unmatched ack. */
function takePending(pending: PendingInjection[], text: string): PendingInjection | undefined {
  const index = pending.findIndex((entry) => entry.text === text);
  if (index === -1) return undefined;
  return pending.splice(index, 1)[0];
}

/**
 * PI's `EngineSession`. `run()` opens a RunEvent stream over the same `PISession`, while
 * `openLegacyProcess()` exposes the byte-identical `AgentProcess` surface the pre-P2.2c pool used
 * (`createAgentProcess` / `sendSpawnedTurn` moved here verbatim); `cancel()` ends a run through
 * `closeTurnStreamFor`, never the pooled session.
 */
export class PIEngineSession implements EngineSession {
  readonly backend: Backend = 'pi';
  /** The pool's reuse key. PI derives it from the fully resolved request (`sessionIdentity`), which
   *  is strictly more precise than `engineIdentity(spec)` because it covers the resolved env, MCP
   *  servers and gateway routing too. SessionEngines (P2.2c) compares this exact string. */
  readonly identity: string;
  readonly capabilities: ReadonlySet<Capability>;
  private readonly session: PISession;
  private readonly onEvict: ((session: PIEngineSession) => void) | undefined;
  private readonly resolveSessionPath: ((sessionId: string) => string | null) | undefined;
  /** The run currently owning the session's single injection-ack slot (PI serves one turn at a
   *  time). `steer()` targets it for id correlation and immediate refusals. */
  private active: { queue: RunEventQueue; pending: PendingInjection[] } | null = null;
  private injectionSeq = 0;
  /** Recorded for diagnostics; PI has no background phase yet, so it never changes run behaviour. */
  private lastAwaitBackground: 'none' | 'inline' | 'hold' = 'none';

  constructor(
    session: PISession,
    request: PiSessionRequest,
    hooks: Pick<PIEngineOpenHooks, 'onEvict' | 'resolveSessionPath'> = {},
  ) {
    this.session = session;
    this.identity = sessionIdentity(request);
    this.onEvict = hooks.onEvict;
    this.resolveSessionPath = hooks.resolveSessionPath;
    // D9 declares capabilities per EngineSession. PI's set happens to be backend-wide today (no
    // per-session narrowing exists), so this is a copy rather than a lookup: a future per-session
    // gate can mutate it without touching the shared matrix.
    this.capabilities = new Set(CAPABILITIES_BY_BACKEND.pi);
  }

  get backendSessionId(): string | null {
    return this.session.sessionId;
  }

  run(prompt: UserMessage, opts: { awaitBackground: 'none' | 'inline' | 'hold' }): EngineRun {
    const stream = this.session.openTurnStream();
    const queue = new RunEventQueue();
    const pending: PendingInjection[] = [];
    this.active = { queue, pending };
    // The ack sink is session-scoped; PI serves one turn at a time, so the live run owns it.
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
    // Accepted and recorded, but changes nothing: PI has no spontaneous continuation turns, so
    // every run is foreground-only and ends after its `turn_complete` (D1).
    this.lastAwaitBackground = opts.awaitBackground;

    const result = this.sendTurn(prompt);
    // The caller observes rejection through `EngineRun.result`; this only prevents an unhandled
    // rejection when a consumer reads `events` without awaiting `result`.
    result.catch(() => undefined);

    void (async () => {
      for await (const event of turnStreamIterable(stream)) {
        queue.push(toRunEvent(event, 'foreground'));
      }
      queue.push({ type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0 });
      queue.close();
    })();

    return {
      events: {
        [Symbol.asyncIterator]: (): AsyncIterator<RunEvent> => ({ next: () => queue.next() }),
      },
      result,
      // Ends this run, not the session: the session stays pooled and serves the next run.
      cancel: () => { this.session.closeTurnStreamFor(stream); },
    };
  }

  /** The same promise shape `PIAdapter.sendSpawnedTurn` builds. A fresh/reused `PISession` serves
   *  its own transcript (`currentSessionId === sessionId`), so no resume switch is needed here. */
  private sendTurn(message: UserMessage): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve, reject) => {
      this.session.beginTurn(resolve, reject);
      this.session.sendTurn(this.session.sessionId, this.session.sessionFile, message)
        .catch((error) => this.session.beginTurnReject(errorValue(error)));
    });
  }

  steer(msg: UserMessage): { accepted: boolean; injectionId?: string } {
    const injectionId = this.nextInjectionId();
    const accepted = this.session.injectUserMessage(msg);
    if (!accepted) {
      // A refused injection never reaches PI's ack queue, so surface the rejection from here.
      this.active?.queue.push({ type: 'injection_rejected', injectionId, reason: 'refused' });
      return { accepted: false, injectionId };
    }
    this.active?.pending.push({ id: injectionId, text: msg.text });
    return { accepted: true, injectionId };
  }

  respondToDialog(dialogId: string, payload: Record<string, unknown>): boolean {
    return this.session.sendExtensionUiResponse(dialogId, payload);
  }

  compact(): Promise<AgentCompactResult> {
    return this.session.compact();
  }

  close(): Promise<void> {
    return this.session.close();
  }

  kill(): boolean {
    const killed = this.session.kill();
    if (killed) this.onEvict?.(this);
    return killed;
  }

  /** The pool's liveness test: a session that self-terminated must not be reused. */
  isAlive(): boolean {
    return this.session.isAlive();
  }

  /** Re-point the pooled runtime at another transcript (session rewind). Mutates the same
   *  `currentSessionId` the legacy send path reads, exactly as `PIAdapter.switchSession` did. */
  async switchSession(sessionId: string, targetPath: string): Promise<SwitchResult> {
    const result = await this.session.sendSwitchSession(targetPath);
    if (result.ok) this.session.currentSessionId = sessionId;
    return result;
  }

  /** TRANSITIONAL (deleted in P4.1): the legacy AgentProcess surface over this same session,
   *  byte-identical to what PIAdapter.createAgentProcess built. Lets SessionEngines own the pool
   *  before the facade's event plumbing moves to RunEvent. */
  openLegacyProcess(engineKey: string): PIAgentProcess {
    return this.createLegacyProcess(engineKey, this.session.openTurnStream());
  }

  private sendSpawnedTurn(session: PISession, msg: UserMessage): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve, reject) => {
      session.beginTurn(resolve, reject);
      const targetId = session.sessionId;
      const targetPath = targetId === null ? null : this.resolveSessionPath?.(targetId) ?? null;
      session.sendTurn(targetId, targetPath, msg)
        .catch((error) => session.beginTurnReject(errorValue(error)));
    });
  }

  private createLegacyProcess(engineKey: string, turnStream: EventQueue): PIAgentProcess {
    const session = this.session;
    return {
      sessionKey: engineKey,
      get sessionId(): string | null { return session.sessionId; },
      send: (msg) => this.sendSpawnedTurn(session, msg),
      compact: () => session.compact(),
      sendExtensionUiResponse: (id, payload) => session.sendExtensionUiResponse(id, payload),
      injectUserMessage: (msg) => session.injectUserMessage(msg),
      setInjectionAckSink: (sink) => session.setInjectionAckSink(sink),
      events: turnStreamIterable(turnStream),
      // Out-of-band attribution (see AgentProcess.pushTurnEvent). Bound to THIS run's queue, so a
      // late push from an abandoned run cannot leak into the turn that replaced it.
      pushTurnEvent: (event) => {
        if (turnStream.isClosed) return false;
        turnStream.push(event);
        return true;
      },
      // Ends this run, not the session: the session is pooled per engineKey and serves the next
      // turn. Session teardown goes through SessionEngines.close(key) / kill(key).
      close: async () => { session.closeTurnStreamFor(turnStream); },
      kill: () => this.kill(),
    };
  }

  private nextInjectionId(): string {
    return `pi-run-inj-${++this.injectionSeq}`;
  }
}
