// input:  spawn config, provider cache, spawner, settings
// output: PI sessions, resume path registry, events and compact
// pos:    PI backend adapter
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { type ChildProcess } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import { DATA_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { Capability, CAPABILITIES_BY_BACKEND } from '../capabilities.js';
import { resolveMcpComposition } from '../types.js';
import type { AgentAdapter, AgentCompactResult, AgentCompactUsage, AgentProcessSupervision, AgentSpawnConfig, Backend, InjectionAckSink, McpComposition, UserMessage } from '../types.js';
import type { AgentResult } from '@core/types/agent-types.js';
import type { NormalizedEvent } from '../normalize/event-types.js';
import { buildPiEnv, buildSpawnArgs } from './spawn-args.js';
import { createLineSplitter, encodeCommand } from './framing.js';
import { piRpcLineToNormalized, createPIEventParserState, piContextUsageFromStats, type PIEventParserState } from './event-parser.js';
import {
  writeProvidersConfig,
  buildProviderOverrides,
  type ProviderOverride,
} from './providers-config.js';
import { fromCanonical } from '../normalize/tool-names.js';
import { findPISessionFilePath } from './session-files.js';
import type { PIProviderDiscovery } from './discovery.js';
import {
  CLOSE_EXIT_WAIT_MS,
  DEFAULT_PI_BINARY,
  EventQueue,
  PI_IDLE_SESSION_TIMEOUT,
  PI_MAX_TIMEOUT,
  PI_TURN_IDLE_TIMEOUT,
  PIContextUsageProbe,
  PI_CONTEXT_USAGE_TIMEOUT_MS,
  PISteeringQueue,
  SWITCH_SESSION_TIMEOUT_MS,
  buildPromptText,
  defaultPiSpawn,
  isPIContextSampleBoundary,
  parseRpcObject,
  type PendingPiTurn,
  type PIAgentProcess,
  type PISessionOptions,
  type SpawnFn,
  type SwitchResult,
} from './session-support.js';
import {
  DEFAULT_SESSION_DIR, HOOK_BRIDGE_PATH, MCP_BRIDGE_PATH, PI_AGENT_DIR, TOOL_SHIMS_PATH,
  piModelsPath,
} from './defaults.js';
export type { PIAgentProcess } from './session-support.js';
const log = createLogger('pi-adapter');

/** Discovery that reports nothing. The daemon injects the cached host scanner; a trial injects its
 *  single-provider catalog. Neither is a module default here (§13 A7/A8). */
const NO_PROVIDER_DISCOVERY: PIProviderDiscovery = {
  getProviders: () => [],
  refresh: () => {},
};

/**
 * A benchmark spawn is one carrying a compiled policy guard: §6.8 G1 makes the guard mandatory for
 * every benchmark role, so its presence is the marker. Everything a trial must not fall back to is
 * required here, which is what makes each ambient default unreachable rather than merely unused
 * (§13 S6.1, A12, A13).
 */
function assertBenchmarkSpawn(config: AgentSpawnConfig, agentDir: string | undefined): void {
  const missing = [
    ['processSpawner', config.processSpawner],
    ['cliPath', config.cliPath],
    ['cwd', config.cwd],
    ['pinnedEnv', config.pinnedEnv],
    ['agentDir', agentDir],
    ['piGatewayBaseUrl', config.piGatewayBaseUrl],
    ['streamDeltas', config.streamDeltas],
  ].filter(([, value]) => value === undefined).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`PI benchmark spawn is missing required inputs: ${missing.join(', ')}`);
  }
}
type PiTurnComplete = Extract<NormalizedEvent, { type: 'turn_complete' }>;
type CompactBase = Omit<AgentCompactResult, 'contextUsage'>;

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingCompact {
  id: string;
  statsId: string | null;
  base: CompactBase | null;
  resolve: (result: AgentCompactResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compactUsage(data: Record<string, unknown>): AgentCompactUsage | null {
  const usage = record(data['usage']);
  if (Object.keys(usage).length === 0) return null;
  return {
    inputTokens: numberOrNull(usage['input']) ?? 0,
    outputTokens: numberOrNull(usage['output']) ?? 0,
    cacheReadTokens: numberOrNull(usage['cacheRead']) ?? 0,
    cacheWriteTokens: numberOrNull(usage['cacheWrite']) ?? 0,
    costUsd: numberOrNull(record(usage['cost'])['total']),
  };
}

function compactBase(data: unknown): CompactBase {
  const value = record(data);
  return {
    status: 'compacted',
    tokensBefore: numberOrNull(value['tokensBefore']),
    estimatedTokensAfter: numberOrNull(value['estimatedTokensAfter']),
    usage: compactUsage(value),
  };
}

function rpcErrorMessage(raw: Record<string, unknown>): string {
  const error = raw['error'];
  if (typeof error === 'string') return error;
  const nested = record(error)['message'];
  if (typeof nested === 'string') return nested;
  const dataMessage = record(raw['data'])['message'];
  return typeof dataMessage === 'string' ? dataMessage : 'PI compact failed';
}

function isNothingToCompact(message: string): boolean {
  return /no messages to compact/i.test(message);
}

class PISession {
  readonly sessionKey: string;
  /** Session ID assigned at bootstrap (immutable after first session_started). */
  sessionId: string | null = null;
  /** Absolute path to the session JSONL file (from bootstrap get_state.sessionFile). */
  sessionFile: string | null = null;
  /**
   * Session currently active in the subprocess (updated on successful switch_session).
   * Distinct from sessionId: sessionId is the bootstrapped session and never changes;
   * currentSessionId tracks which session the subprocess is presently serving after any
   * switch_session calls.
   */
  currentSessionId: string | null = null;
  private readonly proc: ChildProcess;
  /** Present when the process was launched through a containment supervisor (§13 P1). */
  readonly supervision: AgentProcessSupervision | undefined;
  private readonly events = new EventQueue();
  private readonly splitter = createLineSplitter();
  private readonly parserState: PIEventParserState = createPIEventParserState();
  private readonly registry: Map<string, string>;
  private readonly registrySessionDir: string;
  private readonly onClose: ((sessionKey: string) => void) | undefined;
  private stderrTail = '';
  private alive = true;
  private exitPromise: Promise<void>;
  /** Buffer for assistant_text deltas; flushed on message_end / turn_complete / non-text events. */
  private textBuffer = '';
  /** blockId of the text currently in textBuffer; attached to the flushed assistant_text. */
  private textBlockId: string | null = null;
  /**
   * Streaming preview gate, resolved once at spawn time (CORTEX_STREAM_DELTAS=0 disables it).
   * Only assistant_delta is suppressed — the buffered whole message is unaffected.
   */
  private readonly streamDeltas: boolean;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private turnIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSwitch: {
    id: string;
    resolve: (r: SwitchResult) => void;
    reject: (e: Error) => void;
  } | null = null;
  private pendingSwitchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Accumulator for the current in-flight Cortex turn. Resolved/rejected by handleRawLine. */
  private pendingTurn: PendingPiTurn | null = null;
  private readonly steering = new PISteeringQueue();
  /**
   * Where PI's own agent loop is, tracked off its event stream because the injection RPC form
   * depends on it. `starting` = a prompt is written but PI has not entered the loop yet; PI still
   * reads its internal run flag as inactive there and only the dedicated steer command is safe.
   */
  private loopState: 'idle' | 'starting' | 'running' = 'idle';
  private readonly contextUsageProbe: PIContextUsageProbe;
  private readonly readyWaiters: ReadyWaiter[] = [];
  private pendingCompact: PendingCompact | null = null;
  private compactSequence = 0;

  constructor(opts: PISessionOptions) {
    this.sessionKey = opts.sessionKey;
    this.registry = opts.registry;
    this.registrySessionDir = opts.registrySessionDir;
    this.onClose = opts.onClose;
    this.streamDeltas = opts.streamDeltas;

    const spawned = opts.spawner(opts.command, opts.cliArgs, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = spawned.process;
    this.supervision = spawned.supervision;
    this.contextUsageProbe = new PIContextUsageProbe(
      (command) => {
        const stdin = this.proc.stdin;
        if (!stdin || stdin.destroyed || stdin.writableEnded) throw new Error('PI stdin unavailable');
        stdin.write(encodeCommand(command));
      },
      (event) => this.emitNormalizedEvent(event),
    );

    this.proc.stdout?.on('data', (chunk: Buffer | string) => {
      for (const line of this.splitter.push(chunk)) this.handleRawLine(line);
    });
    this.proc.stderr?.on('data', (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.stderrTail = (this.stderrTail + s).slice(-2000);
    });

    this.exitPromise = new Promise<void>((resolve) => {
      this.proc.once('close', (code: number | null) => {
        this.alive = false;
        const exitError = new Error(this.stderrTail || `pi exited with code ${code ?? 0}`);
        this.settleReadyWaiters(exitError);
        this.rejectCompact(exitError);
        // Reject any pending switch_session promise on unexpected subprocess exit.
        if (this.pendingSwitch !== null) {
          const entry = this.pendingSwitch;
          this.pendingSwitch = null;
          if (this.pendingSwitchTimer !== null) {
            clearTimeout(this.pendingSwitchTimer);
            this.pendingSwitchTimer = null;
          }
          entry.reject(new Error('pi subprocess exited while switch_session was pending'));
        }
        // Seal every accepted steering message before rejecting the outer turn. This releases
        // orchestration's pending UI row and busy bracket even when PI dies before consumption.
        this.steering.abandon();
        this.steering.clearSink();
        // Reject any pending turn promise if the process exits without a turn_complete.
        if (this.pendingTurn !== null) {
          const t = this.pendingTurn;
          this.pendingTurn = null;
          const msg =
            code !== null && code !== 0
              ? this.stderrTail || `pi exited with code ${code}`
              : 'pi subprocess exited before turn_complete';
          t.reject(new Error(msg));
        }
        if (code !== null && code !== 0) {
          // Nice-to-have #1 from Plan Review iter1: surface abrupt failure as a single fatal error event
          // so downstream consumers don't see a silent iterator termination. Full event-parser coverage is task a7f9.
          this.events.push({
            type: 'error',
            message: this.stderrTail || `pi exited with code ${code}`,
            fatal: true,
          });
        }
        this.contextUsageProbe.close();
        this.events.close();
        // Remove stream listeners and destroy streams so stub PassThrough streams
        // (used in tests) don't keep the event loop alive after close.
        this.proc.stdout?.removeAllListeners('data');
        this.proc.stderr?.removeAllListeners('data');
        try { (this.proc.stdout as any)?.destroy?.(); } catch { /* ignore */ }
        try { (this.proc.stderr as any)?.destroy?.(); } catch { /* ignore */ }
        resolve();
      });
    });

    // Send bootstrap frame. Must be the FIRST write. Any additional spawn-time writes would break the
    // id='bootstrap' correlation invariant this skeleton relies on (see Plan Review iter1 nice-to-have #4).
    this.proc.stdin?.write(encodeCommand({ id: 'bootstrap', type: 'get_state' }));

    this.resetIdleTimer();
    this.maxTimer = setTimeout(() => {
      log.info(`Session ${this.sessionKey} hit max timeout, killing`);
      this.kill();
      this.onClose?.(this.sessionKey);
    }, PI_MAX_TIMEOUT);
  }

  /**
   * Flush buffered text as a single assistant_text event, tagged with the blockId its deltas
   * carried so the UI can replace the streamed preview with this authoritative message.
   */
  private flushTextBuffer(): void {
    if (this.textBuffer.length > 0) {
      this.events.push(
        this.textBlockId !== null
          ? { type: 'assistant_text', text: this.textBuffer, blockId: this.textBlockId }
          : { type: 'assistant_text', text: this.textBuffer },
      );
      this.textBuffer = '';
    }
    this.textBlockId = null;
  }

  private clearTimers(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.turnIdleTimer) { clearTimeout(this.turnIdleTimer); this.turnIdleTimer = null; }
    if (this.maxTimer) { clearTimeout(this.maxTimer); this.maxTimer = null; }
    this.contextUsageProbe.close();
    this.flushTextBuffer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log.info(`Session ${this.sessionKey} idle for 65min, closing`);
      this.close();
      this.onClose?.(this.sessionKey);
    }, PI_IDLE_SESSION_TIMEOUT);
  }

  private startTurnIdleTimer(): void {
    this.turnIdleTimer = setTimeout(() => {
      log.info(`Session ${this.sessionKey} turn idle for 60min, killing`);
      this.kill();
      this.onClose?.(this.sessionKey);
    }, PI_TURN_IDLE_TIMEOUT);
  }

  private bumpTurnIdleTimer(): void {
    if (!this.turnIdleTimer) return;
    clearTimeout(this.turnIdleTimer);
    this.startTurnIdleTimer();
  }

  private waitForBootstrap(): Promise<void> {
    if (this.sessionId !== null) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = {} as ReadyWaiter;
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.timer = setTimeout(() => {
        const index = this.readyWaiters.indexOf(waiter);
        if (index !== -1) this.readyWaiters.splice(index, 1);
        reject(new Error('PI compact timed out waiting for bootstrap'));
      }, SWITCH_SESSION_TIMEOUT_MS);
      waiter.timer.unref?.();
      this.readyWaiters.push(waiter);
    });
  }

  private settleReadyWaiters(error?: Error): void {
    for (const waiter of this.readyWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  async compact(): Promise<AgentCompactResult> {
    if (this.pendingCompact) throw new Error('PI compact already in progress');
    await this.waitForBootstrap();
    const id = `compact-${++this.compactSequence}`;
    return new Promise<AgentCompactResult>((resolve, reject) => {
      const timer = setTimeout(
        () => this.rejectCompact(new Error('PI compact timed out')),
        PI_TURN_IDLE_TIMEOUT,
      );
      timer.unref?.();
      this.pendingCompact = { id, statsId: null, base: null, resolve, reject, timer };
      try {
        this.proc.stdin?.write(encodeCommand({ id, type: 'compact' }));
      } catch (error) {
        this.rejectCompact(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleCompactResponse(raw: Record<string, unknown> | null): boolean {
    const pending = this.pendingCompact;
    if (!pending || raw?.['type'] !== 'response') return false;
    if (raw['command'] === 'compact' && raw['id'] === pending.id) {
      this.handleCompactCommandResponse(raw);
      return true;
    }
    if (raw['command'] === 'get_session_stats' && raw['id'] === pending.statsId) {
      this.handleCompactStatsResponse(raw);
      return true;
    }
    return false;
  }

  private handleCompactCommandResponse(raw: Record<string, unknown>): void {
    if (raw['success'] === true) {
      this.requestCompactStats(compactBase(raw['data']));
      return;
    }
    const message = rpcErrorMessage(raw);
    if (isNothingToCompact(message)) {
      this.resolveCompact({
        status: 'not-needed', tokensBefore: null, estimatedTokensAfter: null,
        contextUsage: null, usage: null,
      });
      return;
    }
    this.rejectCompact(new Error(message));
  }

  private requestCompactStats(base: CompactBase): void {
    const pending = this.pendingCompact;
    if (!pending) return;
    pending.base = base;
    pending.statsId = `compact-stats-${++this.compactSequence}`;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(
      () => this.resolveCompact({ ...base, contextUsage: null }),
      PI_CONTEXT_USAGE_TIMEOUT_MS,
    );
    pending.timer.unref?.();
    try {
      this.proc.stdin?.write(encodeCommand({ id: pending.statsId, type: 'get_session_stats' }));
    } catch {
      this.resolveCompact({ ...base, contextUsage: null });
    }
  }

  private handleCompactStatsResponse(raw: Record<string, unknown>): void {
    const base = this.pendingCompact?.base;
    if (!base) return;
    const contextUsage = raw['success'] === true ? piContextUsageFromStats(raw['data']) : null;
    this.resolveCompact({ ...base, contextUsage });
  }

  private resolveCompact(result: AgentCompactResult): void {
    const pending = this.pendingCompact;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCompact = null;
    pending.resolve(result);
  }

  private rejectCompact(error: Error): void {
    const pending = this.pendingCompact;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCompact = null;
    pending.reject(error);
  }

  get eventsIterable(): AsyncIterable<NormalizedEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<NormalizedEvent> => ({
        next: () => this.events.next(),
      }),
    };
  }

  private handleRawLine(line: string): void {
    if (line.length === 0) return;
    this.resetIdleTimer();
    this.bumpTurnIdleTimer();

    const raw = parseRpcObject(line);
    if (this.handleCompactResponse(raw)) return;
    if (this.handleSwitchResponse(raw)) return;
    const finishDeferred = this.handleInjectionProtocol(raw);

    for (const evt of piRpcLineToNormalized(line, this.parserState)) {
      this.captureSessionStarted(evt);
      const output = this.processPendingTurnEvent(evt);
      if (output !== null) this.emitOrProbeContext(output);
    }

    if (finishDeferred) {
      const terminal = this.finishDeferredTurn();
      if (terminal !== null) this.emitOrProbeContext(terminal);
    }
    this.contextUsageProbe.observe(raw);
    if (this.pendingTurn && isPIContextSampleBoundary(raw)) this.contextUsageProbe.requestSnapshot();
  }

  private emitOrProbeContext(event: NormalizedEvent): void {
    if (event.type === 'turn_complete') this.contextUsageProbe.deferTerminal(event);
    else this.emitNormalizedEvent(event);
  }

  /** Correlate switch_session before the generic parser drops its response. */
  private handleSwitchResponse(raw: Record<string, unknown> | null): boolean {
    const pending = this.pendingSwitch;
    if (
      pending === null || raw?.['type'] !== 'response' ||
      raw['command'] !== 'switch_session' || raw['id'] !== pending.id
    ) return false;

    this.pendingSwitch = null;
    if (this.pendingSwitchTimer !== null) {
      clearTimeout(this.pendingSwitchTimer);
      this.pendingSwitchTimer = null;
    }
    const data = raw['data'];
    const cancelled = data && typeof data === 'object'
      ? Boolean((data as Record<string, unknown>)['cancelled'])
      : false;
    pending.resolve({ ok: raw['success'] === true, cancelled });
    return true;
  }

  /** Observe PI-only delivery/rejection events that intentionally stay out of NormalizedEvent. */
  private handleInjectionProtocol(raw: Record<string, unknown> | null): boolean {
    // agent_start is emitted from inside the loop, so it is the first point at which PI's own run
    // flag is provably set; agent_settled is the point at which it is provably clear again.
    if (raw?.['type'] === 'agent_start') this.loopState = 'running';
    else if (raw?.['type'] === 'agent_settled') this.loopState = 'idle';
    if (raw?.['type'] === 'message_start' && this.isUserStart(raw['message'])) {
      const turn = this.pendingTurn;
      if (turn && !turn.openingUserSeen) turn.openingUserSeen = true;
      else if (turn) this.steering.consumeNext();
      return false;
    }
    if (!raw || !this.steering.rejectFromResponse(raw)) return false;
    return !this.steering.hasPending && this.pendingTurn?.deferredCompletion === true;
  }

  private isUserStart(message: unknown): boolean {
    return !!message && typeof message === 'object' &&
      (message as Record<string, unknown>)['role'] === 'user';
  }

  private captureSessionStarted(evt: NormalizedEvent): void {
    if (evt.type !== 'session_started' || this.sessionId !== null) return;
    this.sessionId = evt.sessionId;
    this.currentSessionId = evt.sessionId;
    this.settleReadyWaiters();
    if (evt.sessionFile) {
      this.sessionFile = evt.sessionFile;
      this.registry.set(evt.sessionId, evt.sessionFile);
    } else {
      this.registry.set(evt.sessionId, path.join(this.registrySessionDir, `${evt.sessionId}.jsonl`));
    }
  }

  /** Update the outer send() promise and optionally replace/suppress a terminal event. */
  private processPendingTurnEvent(evt: NormalizedEvent): NormalizedEvent | null {
    const turn = this.pendingTurn;
    if (!turn) return evt;
    if (evt.type === 'plan_written') turn.planFilePath = evt.path;
    // ask_user_question is handled live by the facade; accumulating it would post it twice.
    else if (evt.type === 'ask_user_question') { /* intentionally not accumulated */ }
    else if (evt.type === 'turn_complete') return this.handleTurnComplete(evt);
    else if (evt.type === 'error' && evt.fatal) {
      this.flushTextBuffer();
      this.clearTurnIdleTimer();
      this.steering.abandon();
      this.pendingTurn = null;
      turn.reject(new Error(evt.message));
    }
    return evt;
  }

  private handleTurnComplete(evt: PiTurnComplete): PiTurnComplete | null {
    const turn = this.pendingTurn!;
    this.flushTextBuffer();
    turn.numTurns += evt.numTurns;
    if (evt.totalCostUsd !== null) turn.totalCostUsd = (turn.totalCostUsd ?? 0) + evt.totalCostUsd;
    if (evt.error) {
      this.steering.abandon();
      return this.settlePendingTurn(evt.error);
    }
    if (this.steering.hasPending) {
      turn.deferredCompletion = true;
      return null;
    }
    return this.settlePendingTurn();
  }

  private finishDeferredTurn(): PiTurnComplete | null {
    if (!this.pendingTurn?.deferredCompletion || this.steering.hasPending) return null;
    return this.settlePendingTurn();
  }

  private settlePendingTurn(error?: string): PiTurnComplete {
    const turn = this.pendingTurn!;
    this.pendingTurn = null;
    this.clearTurnIdleTimer();
    const terminal: PiTurnComplete = error
      ? { type: 'turn_complete', numTurns: turn.numTurns, totalCostUsd: turn.totalCostUsd, error }
      : { type: 'turn_complete', numTurns: turn.numTurns, totalCostUsd: turn.totalCostUsd };
    if (error) turn.reject(new Error(error));
    else turn.resolve(this.buildAgentResult(turn));
    return terminal;
  }

  private buildAgentResult(turn: PendingPiTurn): AgentResult {
    return {
      sessionId: this.sessionId,
      total_cost_usd: turn.totalCostUsd,
      num_turns: turn.numTurns,
      rateLimited: false,
      rateLimitMessage: null,
      planFilePath: turn.planFilePath,
      enteredPlanMode: false,
      exitedPlanMode: turn.planFilePath !== null,
      askUserQuestions: turn.askUserQuestions.length > 0 ? turn.askUserQuestions : undefined,
      finalOutput: null,
    };
  }

  private clearTurnIdleTimer(): void {
    if (!this.turnIdleTimer) return;
    clearTimeout(this.turnIdleTimer);
    this.turnIdleTimer = null;
  }

  /** Buffer deltas into whole assistant messages while preserving Web preview events. */
  private emitNormalizedEvent(evt: NormalizedEvent): void {
    if (evt.type === 'context_usage') {
      this.events.push(evt);
      return;
    }
    if (evt.type !== 'assistant_text') {
      this.flushTextBuffer();
      this.events.push(evt);
      if (evt.type === 'turn_complete') this.events.close();
      return;
    }
    const blockId = evt.blockId ?? null;
    if (this.textBuffer.length > 0 && blockId !== this.textBlockId) this.flushTextBuffer();
    this.textBlockId = blockId;
    if (this.streamDeltas && blockId !== null) {
      this.events.push({ type: 'assistant_delta', text: evt.text, blockId });
    }
    this.textBuffer += evt.text;
  }

  send(msg: UserMessage): void {
    if (!this.alive) throw new Error('PISession.send: subprocess is not alive');
    this.writeOpeningPrompt(buildPromptText(msg));
  }

  private writeOpeningPrompt(promptText: string): void {
    const stdin = this.proc.stdin;
    if (!stdin) throw new Error('PISession: subprocess stdin is unavailable');
    stdin.write(encodeCommand({ type: 'prompt', message: promptText }));
    this.loopState = 'starting';
    if (this.pendingTurn) this.pendingTurn.promptDispatched = true;
  }

  /**
   * Queue a message at PI's next agent-loop boundary without opening a new Cortex run.
   *
   * The RPC form has to follow PI's loop state. A `prompt` with streamingBehavior=steer is only
   * queued when PI already considers itself streaming; written during the prompt preflight window
   * (which includes our own before_agent_start hook scripts, seconds long) PI instead takes its
   * plain-prompt path, acks success, then throws internally and drops the message — and that failed
   * path clears PI's run flag, so every later injection in the same turn takes the same broken
   * branch. The dedicated `steer` command bypasses that check entirely and is drained by the
   * opening steering poll of the loop that is about to start. Once the loop is running, or once PI
   * has settled and the message must reopen a turn, prompt+steer is the correct form.
   */
  injectUserMessage(msg: UserMessage): boolean {
    const stdin = this.proc.stdin;
    if (
      !this.alive || !this.pendingTurn?.promptDispatched || !stdin ||
      stdin.destroyed || stdin.writableEnded
    ) return false;
    const entry = this.steering.begin(msg.text);
    const message = buildPromptText(msg);
    const preflight = this.loopState === 'starting';
    try {
      stdin.write(encodeCommand(preflight
        ? { id: entry.id, type: 'steer', message }
        : { id: entry.id, type: 'prompt', message, streamingBehavior: 'steer' }));
      // A prompt written to an idle PI opens a fresh run, so the next injection is a preflight one.
      if (this.loopState === 'idle') this.loopState = 'starting';
      return true;
    } catch {
      this.steering.rollback(entry);
      return false;
    }
  }

  setInjectionAckSink(sink: InjectionAckSink): void {
    this.steering.setSink(sink);
  }

  /**
   * Send switch_session RPC and await ack from pi.
   * Returns {ok:false, cancelled:false} if subprocess is dead (no-op, no throw).
   * Rejects if another switch is already pending (programming error).
   */
  sendSwitchSession(targetPath: string): Promise<SwitchResult> {
    if (!this.alive) return Promise.resolve({ ok: false, cancelled: false });
    if (this.pendingSwitch !== null) {
      return Promise.reject(new Error('PISession.sendSwitchSession: switch already pending'));
    }
    const id = `sw-${Date.now()}`;
    return new Promise<SwitchResult>((resolve, reject) => {
      this.pendingSwitch = { id, resolve, reject };
      this.pendingSwitchTimer = setTimeout(() => {
        if (this.pendingSwitch?.id === id) {
          this.pendingSwitch = null;
          this.pendingSwitchTimer = null;
          reject(new Error(`PISession.sendSwitchSession: timeout after ${SWITCH_SESSION_TIMEOUT_MS}ms`));
        }
      }, SWITCH_SESSION_TIMEOUT_MS);
      this.proc.stdin?.write(encodeCommand({ id, type: 'switch_session', sessionPath: targetPath }));
    });
  }

  /**
   * Send a user message, auto-switching to targetSessionId first if the subprocess
   * is currently serving a different session.
   *
   * BLOCKER-1 fix: prompt is written in both the switch and no-switch branches.
   * BLOCKER-2 wire-up: spawn closure calls this instead of send() so auto-switch fires.
   */
  async sendTurn(
    targetSessionId: string,
    targetPath: string | null,
    message: UserMessage,
  ): Promise<{ switched: boolean; cancelled: boolean }> {
    if (!this.alive) throw new Error('PISession.sendTurn: subprocess is not alive');

    const promptText = buildPromptText(message);
    if (this.currentSessionId !== targetSessionId) {
      if (targetPath === null) {
        // Can't switch without a path; write prompt to current session as fallback.
        this.writeOpeningPrompt(promptText);
        return { switched: false, cancelled: false };
      }
      const result = await this.sendSwitchSession(targetPath);
      if (result.ok) {
        this.currentSessionId = targetSessionId;
      }
      // BLOCKER-1 fix: write prompt in every branch regardless of result.ok.
      // NTH-A: if result.ok===false (pi rejected switch), the prompt goes to the current
      // (un-switched) session — intentional best-effort, caller can inspect result.ok.
      this.writeOpeningPrompt(promptText);
      return { switched: result.ok, cancelled: result.cancelled };
    }

    // Same session: write prompt directly.
    this.writeOpeningPrompt(promptText);
    return { switched: false, cancelled: false };
  }

  /**
   * Send extension_ui_response for a pending extension_ui_request dialog.
   * Call this after receiving ask_user_question NormalizedEvent to unblock the tool shim.
   * Payload fields depend on the dialog method:
   *   select/input/editor: { value: string } or { cancelled: true }
   *   confirm: { confirmed: boolean } or { cancelled: true }
   */
  sendExtensionUiResponse(id: string, payload: Record<string, unknown>): void {
    if (!this.alive) return;
    this.proc.stdin?.write(encodeCommand({ type: 'extension_ui_response', id, ...payload }));
  }

  /** Begin a new turn: set up the pendingTurn accumulator before writing the prompt.
   *  If a turn is already in-flight, reject it (superseded) before opening the new one
   *  so the orphaned Promise doesn't leak and keep the event loop alive. */
  beginTurn(
    resolve: (r: AgentResult) => void,
    reject: (e: Error) => void,
  ): void {
    // Reject any turn that was already in-flight before this one overwrites it.
    // Without this, calling send() before the previous turn completes orphans the
    // previous Promise, which holds a pending ref that keeps the event loop alive.
    this.beginTurnReject(new Error('PISession.beginTurn: superseded by a newer send()'));
    this.pendingTurn = {
      resolve,
      reject,
      planFilePath: null,
      askUserQuestions: [],
      numTurns: 0,
      totalCostUsd: null,
      promptDispatched: false,
      openingUserSeen: false,
      deferredCompletion: false,
    };
    this.startTurnIdleTimer();
  }

  /** Belt-and-suspenders: reject the pendingTurn if it is still outstanding (i.e., not yet resolved by events). */
  beginTurnReject(err: Error): void {
    if (this.pendingTurn !== null) {
      const t = this.pendingTurn;
      this.pendingTurn = null;
      this.steering.abandon();
      t.reject(err);
    }
  }

  async close(): Promise<void> {
    this.clearTimers();
    if (!this.alive) return;
    try {
      this.proc.stdin?.end();
    } catch {
      // best-effort
    }
    const timer = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), CLOSE_EXIT_WAIT_MS),
    );
    const outcome = await Promise.race([this.exitPromise.then(() => 'exited' as const), timer]);
    if (outcome === 'timeout' && this.alive) {
      this.kill();
      await this.exitPromise;
    }
  }

  kill(): boolean {
    this.clearTimers();
    if (!this.alive) return false;
    const ok = this.proc.kill('SIGTERM');
    return ok;
  }
}

/** Collaborators the daemon owns and a trial replaces. Both are injected rather than defaulted so
 *  the host PI home and its auth mirroring are not reachable from this module (§13 A1, A6). */
export interface PIAdapterHooks {
  /** `PI_CODING_AGENT_DIR` for every session this instance spawns (§13 P4). */
  agentDir?: string;
  /** Run before spawn with the resolved agent dir: the daemon mirrors the host credential here, a
   *  trial writes its dummy token. Never a module default (§13 A5/A6). */
  prepareAgentDir?: (agentDir: string) => void;
}

export class PIAdapter implements AgentAdapter {
  readonly backend: Backend = 'pi';
  readonly capabilities: Set<Capability> = CAPABILITIES_BY_BACKEND.pi;
  private readonly sessions = new Map<string, PISession>();
  private readonly spawner: SpawnFn;
  private readonly providerDiscovery: PIProviderDiscovery;
  private readonly configuredProviderOverrides = new Map<string, ProviderOverride>();
  private readonly sessionPathRegistry = new Map<string, string>();
  /** Injected PI home, or undefined when the caller left it to the daemon default. */
  private readonly configuredAgentDir: string | undefined;
  private readonly prepareAgentDir: ((agentDir: string) => void) | undefined;
  /** sessionDir for the <sessionId>.jsonl path convention. Exposed for tests. */
  readonly sessionDir: string;

  constructor(
    spawner: SpawnFn = defaultPiSpawn,
    sessionDir: string = DEFAULT_SESSION_DIR,
    providerDiscovery: PIProviderDiscovery = NO_PROVIDER_DISCOVERY,
    hooks: PIAdapterHooks = {},
  ) {
    this.spawner = spawner;
    this.sessionDir = sessionDir;
    this.providerDiscovery = providerDiscovery;
    this.configuredAgentDir = hooks.agentDir;
    this.prepareAgentDir = hooks.prepareAgentDir;
  }

  private gatewayOverrides(
    discovered: string[],
    currentProvider: string | null,
    gatewayPath: string | null,
  ): ProviderOverride[] {
    if (currentProvider) {
      const [current] = buildProviderOverrides([], currentProvider, gatewayPath);
      this.configuredProviderOverrides.set(currentProvider, current);
    }
    const byName = new Map(
      buildProviderOverrides(discovered, null, null).map((override) => [override.name, override]),
    );
    for (const override of this.configuredProviderOverrides.values()) byName.set(override.name, override);
    return Array.from(byName.values());
  }

  spawn(config: AgentSpawnConfig): PIAgentProcess {
    const guard = config.benchmarkPolicyGuard;
    if (guard !== undefined) assertBenchmarkSpawn(config, this.configuredAgentDir);
    // P13: the two benchmark compositions are supported now. Strictness is not a promise made in a
    // comment — the bridge derives its server set from this value, so `none` yields zero servers and
    // `benchmark-thread-run` yields exactly `cortex-benchmark-thread` (§5.6 P1).
    const composition = resolveMcpComposition(config.mcpComposition, config.cortexContext?.useCoreMcp);
    const agentDir = this.configuredAgentDir ?? PI_AGENT_DIR;
    const sessionDir = this.sessionDir;
    mkdirSync(sessionDir, { recursive: true });

    // Resolve the backend id to one exact path before spawn and pass that path to --session.
    // PI therefore opens the selected transcript directly instead of scanning session bodies.
    // The live registry carries PI's authoritative sessionFile; after restart, deterministic
    // filename lookup prefers the canonical id form, then the newest timestamp-prefixed form.
    // A missing target starts fresh because PI cannot create an externally assigned session id.
    const wantResume = !!(config.resume && config.sessionId);
    const sessionPathForSpawn = wantResume
      ? this.resolveSessionPath(config.sessionId!)
      : null;
    if (wantResume && sessionPathForSpawn === null) {
      log.info(`PI resume target '${config.sessionId}' not found (no live session or file in ${sessionDir}); starting fresh`);
    }

    const cliArgs = buildSpawnArgs({
      sessionDir,
      sessionPath: sessionPathForSpawn,
      model: config.model ?? null,
      provider: config.piProvider ?? null,
      systemPrompt: config.systemPrompt ?? null,
      appendSystemPrompt: config.appendSystemPrompt ?? null,
      pluginDirs: config.pluginDirs ?? null,
      // P9: the MCP bridge and the guard's host (tool shims) are always injected; the hook bridge is
      // derived from the role, so a role that declares no hook surface never loads it.
      extensionPaths: config.disableHooks === true
        ? [MCP_BRIDGE_PATH, TOOL_SHIMS_PATH]
        : [MCP_BRIDGE_PATH, TOOL_SHIMS_PATH, HOOK_BRIDGE_PATH],
      thinking: config.thinking ?? null,
      extraOption: config.extraOption ?? null,
    });

    // Pre-spawn config sync (sole writers of PI_AGENT_DIR — no other code path touches these files):
    //  1. Mirror user's ~/.pi/agent/auth.json so the PI subprocess can resolve OAuth/API key auth
    //  2. Write multi-provider models.json overriding every discovered PI provider's baseUrl to
    //     land on the local gateway. PI uses its "Override Built-in Providers" mechanism
    //     (PI docs/models.md §Overriding Built-in Providers) — only baseUrl is set, auth is
    //     resolved from auth.json as usual.
    if (config.piGatewayBaseUrl) {
      try {
        this.prepareAgentDir?.(agentDir);
      } catch (err) {
        log.warn(`Failed to prepare the PI agent dir: ${(err as Error).message}`);
      }
      try {
        // Override set = providers PI reports creds for (discovered) ∪ the provider THIS spawn
        // uses (config.piProvider). The current provider is always routed through the gateway even
        // when discovery doesn't list it (e.g. an anthropic-protocol relay whose key the gateway
        // injects). config.piGatewayPath, when set, decouples the gateway route from the provider name.
        const discovered = this.providerDiscovery.getProviders();
        const overrides = this.gatewayOverrides(
          discovered,
          config.piProvider ?? null,
          config.piGatewayPath ?? null,
        );
        if (overrides.length > 0) {
          // A3: the catalog lands where the agent dir says, never at an implicit host default.
          writeProvidersConfig(overrides, config.piGatewayBaseUrl, {
            modelsPath: piModelsPath(agentDir),
          });
        } else {
          log.warn('No PI providers to route (empty discovery and no profile provider); PI subprocess may fail to authenticate');
        }
      } catch (err) {
        log.warn(`Failed to write PI models.json: ${(err as Error).message}`);
      }
    }

    // Forward the agent's tool allowlist (Claude-native names) so tool-shims.ts can gate which
    // pseudo-tools it registers — mirroring the Claude backend's `--tools` allowlist. Without this,
    // thread-dispatched agents (whose config excludes AskUserQuestion/EnterPlanMode/ExitPlanMode)
    // would still be handed those interaction tools and deadlock on an approval no human can answer.
    // P11: with a guard present the allow-list no longer decides anything — GT6's dispatch guard
    // does — so the fail-open variable is not even exported into the child.
    const allowedTools = guard !== undefined
      ? undefined
      : config.rawTools
        ?? (config.tools && config.tools.length > 0
          ? config.tools.map((t) => fromCanonical('claude', t)).filter((n): n is string => !!n).join(',')
          : undefined);
    const env = buildPiEnv({
      sessionId: config.sessionId,
      // C7/A13: `channel` is what emits SLACK_CHANNEL / FEISHU_CHANNEL — a platform surface a trial
      // has no business naming, and the switch that layers the Slack and Feishu MCP servers.
      channel: guard === undefined ? config.channel : undefined,
      callbackSource: config.callbackSource,
      scheduleTaskId: config.scheduleTaskId,
      extraEnv: config.env,
      context: config.cortexContext,
      piAgentDir: agentDir,
      allowedTools,
      policyGuard: guard,
      mcpComposition: composition,
      deadlineEpochMs: config.benchmarkDeadlineEpochMs,
      // A13: the trial's exact allowlisted environment replaces host inheritance wholesale.
    }, config.pinnedEnv);
    const cwd = config.cwd ?? DATA_DIR;

    const session = new PISession({
      sessionKey: config.sessionKey,
      sessionDir,
      // P2: one resolved binary for the whole session; PATH resolution is the daemon's fallback.
      command: config.cliPath ?? DEFAULT_PI_BINARY,
      cliArgs,
      cwd,
      env,
      // S6.1: the spawn config is the single supervisor injection point for both backends. The
      // constructor argument survives only as a test seam.
      spawner: config.processSpawner ?? this.spawner,
      // A15: an explicit per-spawn value, never a watched daemon setting, on the benchmark path.
      streamDeltas: config.streamDeltas ?? getSettings().streamDeltas,
      registry: this.sessionPathRegistry,
      registrySessionDir: sessionDir,
      onClose: (key) => this.sessions.delete(key),
    });
    this.sessions.set(config.sessionKey, session);

    return {
      supervision: session.supervision,
      sessionKey: config.sessionKey,
      get sessionId(): string | null {
        return session.sessionId;
      },
      // BLOCKER-2 fix: route through session.sendTurn so auto-switch fires when subprocess
      // was diverted to a different session via PIAdapter.switchSession().
      // targetId = session.sessionId keeps this AgentProcess faithful to its bootstrapped session.
      // AgentResult reconstruction (task 5b5c): beginTurn() sets up the accumulator; the
      // pendingTurn promise is resolved/rejected by handleRawLine as events arrive.
      send: (msg: UserMessage): Promise<AgentResult> => {
        return new Promise<AgentResult>((resolve, reject) => {
          // Register accumulator BEFORE writing the prompt so no events are missed.
          session.beginTurn(resolve, reject);
          const targetId = session.sessionId;
          if (targetId !== null) {
            const targetPath = this.resolveSessionPath(targetId);
            // sendTurn errors (e.g. switch_session timeout) surface via the events stream
            // as a fatal error event, which will reject pendingTurn. The catch here is a
            // belt-and-suspenders guard for programming errors in sendTurn itself.
            session.sendTurn(targetId, targetPath, msg).catch((err) => {
              // Only reject if pendingTurn is still ours (hasn't been resolved by events).
              const e = err instanceof Error ? err : new Error(String(err));
              session.beginTurnReject(e);
            });
          } else {
            // Bootstrap not yet complete; send directly (no switch possible yet).
            session.send(msg);
          }
        });
      },
      compact: (): Promise<AgentCompactResult> => session.compact(),
      sendExtensionUiResponse: (id: string, payload: Record<string, unknown>): void => {
        session.sendExtensionUiResponse(id, payload);
      },
      injectUserMessage: (msg: UserMessage): boolean => session.injectUserMessage(msg),
      setInjectionAckSink: (sink: InjectionAckSink): void => session.setInjectionAckSink(sink),
      events: session.eventsIterable,
      close: async () => {
        await session.close();
        this.sessions.delete(config.sessionKey);
      },
      kill: () => {
        const ok = session.kill();
        if (ok) this.sessions.delete(config.sessionKey);
        return ok;
      },
    };
  }

  /** Record the exact transcript path restored by rewind before the next resume spawn. */
  registerSessionPath(sessionId: string, sessionPath: string): void {
    this.sessionPathRegistry.set(sessionId, sessionPath);
  }

  /**
   * Resolve an existing JSONL path from the live registry or filename-only disk discovery.
   * Stale and synthesized registry entries are evicted before discovery.
   */
  resolveSessionPath(sessionId: string): string | null {
    const registered = this.sessionPathRegistry.get(sessionId);
    if (registered && existsSync(registered)) return registered;
    if (registered) this.sessionPathRegistry.delete(sessionId);
    const discovered = findPISessionFilePath(this.sessionDir, sessionId);
    if (discovered) this.sessionPathRegistry.set(sessionId, discovered);
    return discovered;
  }

  /**
   * Switch an existing subprocess (identified by onSessionKey) to serve a different PI session.
   * Returns {ok:false, cancelled:false} if the session key or target session ID is unknown.
   * NTH-1: onSessionKey routes the switch to the correct subprocess (spec done-when #1 omits it,
   * but it is architecturally required for multi-session adapters).
   */
  async switchSession(sessionId: string, onSessionKey: string): Promise<SwitchResult> {
    const session = this.sessions.get(onSessionKey);
    if (!session) return { ok: false, cancelled: false };
    const targetPath = this.resolveSessionPath(sessionId);
    if (targetPath === null) return { ok: false, cancelled: false };
    const result = await session.sendSwitchSession(targetPath);
    if (result.ok) session.currentSessionId = sessionId;
    return result;
  }

  async close(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    await session.close();
    this.sessions.delete(sessionKey);
  }

  kill(sessionKey: string): boolean {
    const session = this.sessions.get(sessionKey);
    if (!session) return false;
    const ok = session.kill();
    if (ok) this.sessions.delete(sessionKey);
    return ok;
  }

  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }
}
