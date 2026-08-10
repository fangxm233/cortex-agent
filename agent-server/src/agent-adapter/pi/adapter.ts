// input:  Spawn config, provider cache, benchmark MCP policy
// output: PI process facade, sessions, events, compact
// pos:    Coordinates PI process and session lifecycles
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import * as path from 'path';
import { DATA_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { Capability, CAPABILITIES_BY_BACKEND } from '../capabilities.js';
import { resolveMcpComposition } from '../types.js';
import type { AgentAdapter, AgentCompactResult, AgentCompactUsage, AgentProcessSupervision, AgentSpawnConfig, Backend, InjectionAckSink, McpComposition, UserMessage } from '../types.js';
import type { AgentResult } from '@core/types/agent-types.js';
import type { NormalizedEvent } from '../normalize/event-types.js';
import {
  buildPiEnv, buildSpawnArgs, PI_BENCHMARK_THREAD_POLICY_ENV, type PISpawnOptions,
} from './spawn-args.js';
import { writePiPluginMcpConfig } from './mcp-config.js';
import { createLineSplitter, encodeCommand } from './framing.js';
import { piRpcLineToNormalized, createPIEventParserState, piContextUsageFromStats, type PIEventParserState } from './event-parser.js';
import {
  writeProvidersConfig,
  buildProviderOverrides,
  withCustomEntries,
  type ProviderOverride,
} from './providers-config.js';
import { readCustomProviderEntries } from './custom-catalog.js';
import { fromCanonical } from '../normalize/tool-names.js';
import { findPISessionFilePath } from './session-files.js';
import { reportCodexQuota, resolveQuotaSource } from './quota-sink.js';
import type { CodexQuotaReading } from '@domain/costs/codex-quota.js';
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
  DEFAULT_SESSION_DIR, HOOK_BRIDGE_PATH, MCP_BRIDGE_PATH, PI_AGENT_DIR, QUOTA_PROBE_PATH,
  TOOL_SHIMS_PATH,
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
  private readonly onProviderQuota: ((reading: CodexQuotaReading) => void) | undefined;
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
    this.onProviderQuota = opts.onProviderQuota;
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
      this.captureProviderQuota(evt);
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

  /** Forward a provider quota reading, which arrives independently of any pending turn. */
  private captureProviderQuota(evt: NormalizedEvent): void {
    if (evt.type !== 'rate_limit') return;
    const reading = evt.raw as CodexQuotaReading | null;
    if (reading?.windows?.length) this.onProviderQuota?.(reading);
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

type QuotaReportingConfig = Pick<AgentSpawnConfig, 'piGatewayBaseUrl' | 'benchmarkPolicyGuard'>;

/**
 * A spawn reports provider quota when Cortex routes its traffic (`piGatewayBaseUrl`) and it is not
 * a benchmark trial. The compiled guard is the trial marker (§6.8 G1), and a trial must stay out of
 * daemon-wide state: its readings would throttle production work on behalf of an experiment.
 */
function reportsProviderQuota(config: QuotaReportingConfig): boolean {
  return !!config.piGatewayBaseUrl && config.benchmarkPolicyGuard === undefined;
}

function buildExtensionPaths(config: Pick<AgentSpawnConfig, 'disableHooks'> & QuotaReportingConfig): string[] {
  const paths = [MCP_BRIDGE_PATH, TOOL_SHIMS_PATH];
  if (config.disableHooks !== true) paths.push(HOOK_BRIDGE_PATH);
  if (reportsProviderQuota(config)) paths.push(QUOTA_PROBE_PATH);
  return paths;
}

type BenchmarkGuard = AgentSpawnConfig['benchmarkPolicyGuard'];
type ProviderQuotaReporter = NonNullable<PISessionOptions['onProviderQuota']>;

interface PreparedPISpawn {
  sessionDir: string;
  cliArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function piSpawnOptions(
  config: AgentSpawnConfig,
  sessionDir: string,
  sessionPath: string | null,
): PISpawnOptions {
  return {
    sessionDir,
    sessionPath,
    model: config.model ?? null,
    provider: config.piProvider ?? null,
    systemPrompt: config.systemPrompt ?? null,
    appendSystemPrompt: config.appendSystemPrompt ?? null,
    pluginDirs: config.pluginDirs ?? null,
    pluginSkillDirs: config.pluginSkillDirs ?? null,
    extensionPaths: buildExtensionPaths(config),
    thinking: config.thinking ?? null,
    extraOption: config.extraOption ?? null,
  };
}

function spawnAllowedTools(config: AgentSpawnConfig, guard: BenchmarkGuard): string | undefined {
  if (guard !== undefined) return undefined;
  const canonical = config.tools && config.tools.length > 0
    ? config.tools.map((tool) => fromCanonical('claude', tool))
      .filter((name): name is string => !!name).join(',')
    : undefined;
  return config.rawTools ?? canonical;
}

function piSubagentMarker(config: AgentSpawnConfig): string | undefined {
  return config.env?.CORTEX_PI_SUBAGENT === '1' ? '1' : undefined;
}

function allowsPluginMcp(composition: McpComposition, subagentMarker: string | undefined): boolean {
  if (composition === 'direct') return true;
  return composition === 'thread-control' && subagentMarker === undefined;
}

function spawnPluginMcpPath(
  config: AgentSpawnConfig,
  composition: McpComposition,
  subagentMarker: string | undefined,
): string | undefined {
  if (!allowsPluginMcp(composition, subagentMarker)) return undefined;
  if (!config.mcpServers || config.mcpServers.length === 0) return undefined;
  return writePiPluginMcpConfig(config.mcpServers).path;
}

type BenchmarkServerConfig = { env?: Record<string, unknown> };

function benchmarkServerConfig(file: string): BenchmarkServerConfig[] {
  const document = JSON.parse(readFileSync(file, 'utf8')) as {
    mcpServers?: Record<string, BenchmarkServerConfig>;
  };
  const server = document.mcpServers?.['cortex-benchmark-thread'];
  return server === undefined ? [] : [server];
}

function benchmarkThreadPolicyPath(
  config: AgentSpawnConfig,
  composition: McpComposition,
): string | undefined {
  if (composition !== 'benchmark-thread-run') return undefined;
  const servers = (config.mcpConfigPaths ?? []).flatMap(benchmarkServerConfig);
  if (servers.length !== 1) throw new Error('Benchmark PI spawn requires one thread MCP server');
  const policyPath = servers[0].env?.[PI_BENCHMARK_THREAD_POLICY_ENV];
  if (typeof policyPath !== 'string' || !path.isAbsolute(policyPath)) {
    throw new Error(`Benchmark PI spawn requires absolute ${PI_BENCHMARK_THREAD_POLICY_ENV}`);
  }
  return policyPath;
}

function buildSpawnEnvironment(
  config: AgentSpawnConfig,
  agentDir: string,
  composition: McpComposition,
): NodeJS.ProcessEnv {
  const guard = config.benchmarkPolicyGuard;
  const subagentMarker = piSubagentMarker(config);
  return buildPiEnv({
    sessionId: config.sessionId,
    channel: guard === undefined ? config.channel : undefined,
    callbackSource: config.callbackSource,
    scheduleTaskId: config.scheduleTaskId,
    extraEnv: config.env,
    context: config.cortexContext,
    piAgentDir: agentDir,
    allowedTools: spawnAllowedTools(config, guard),
    policyGuard: guard,
    leaseState: config.benchmarkLeaseState,
    mcpComposition: composition,
    deadlineEpochMs: config.benchmarkDeadlineEpochMs,
    pluginMcpConfigPath: spawnPluginMcpPath(config, composition, subagentMarker),
    benchmarkThreadPolicyPath: benchmarkThreadPolicyPath(config, composition),
    subagentMarker,
  }, config.pinnedEnv);
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Collaborators the daemon owns and a trial replaces. Both are injected rather than defaulted so
 *  the host PI home and its auth mirroring are not reachable from this module (§13 A1, A6). */
export interface PIAdapterHooks {
  /** `PI_CODING_AGENT_DIR` for every session this instance spawns (§13 P4). */
  agentDir?: string;
  /** Run before spawn with the resolved agent dir: the daemon mirrors the host credential here, a
   *  trial writes its dummy token. Never a module default (§13 A5/A6). */
  prepareAgentDir?: (agentDir: string) => void;
  /** The user's PI catalog (`~/.pi/agent/models.json`), source of user-defined provider
   *  definitions. Injected, never defaulted: reading the host PI home is exactly the ambient reach
   *  a trial must not have (§13 A1). Left unset, no custom provider is mirrored. */
  userModelsPath?: string;
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
  /** Injected user catalog path, or undefined when this instance mirrors no custom provider. */
  private readonly userModelsPath: string | undefined;
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
    this.userModelsPath = hooks.userModelsPath;
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

  private resolveSpawnSessionPath(config: AgentSpawnConfig, sessionDir: string): string | null {
    if (!config.resume || !config.sessionId) return null;
    const sessionPath = this.resolveSessionPath(config.sessionId);
    if (sessionPath === null) {
      log.info(`PI resume target '${config.sessionId}' not found (no live session or file in ${sessionDir}); starting fresh`);
    }
    return sessionPath;
  }

  private prepareGatewayAgentDir(agentDir: string, guard: BenchmarkGuard): void {
    try {
      this.prepareAgentDir?.(agentDir);
    } catch (error) {
      if (guard !== undefined) throw error;
      log.warn(`Failed to prepare the PI agent dir: ${(error as Error).message}`);
    }
  }

  private writeGatewayProviders(
    config: AgentSpawnConfig,
    agentDir: string,
    gatewayBaseUrl: string,
    guard: BenchmarkGuard,
  ): void {
    try {
      this.writeGatewayProvidersUnchecked(config, agentDir, gatewayBaseUrl);
    } catch (error) {
      if (guard !== undefined) throw error;
      log.warn(`Failed to write PI models.json: ${(error as Error).message}`);
    }
  }

  private writeGatewayProvidersUnchecked(
    config: AgentSpawnConfig,
    agentDir: string,
    gatewayBaseUrl: string,
  ): void {
    const overrides = withCustomEntries(
      this.gatewayOverrides(
        this.providerDiscovery.getProviders(),
        config.piProvider ?? null,
        config.piGatewayPath ?? null,
      ),
      this.userModelsPath ? readCustomProviderEntries(this.userModelsPath) : {},
    );
    if (overrides.length === 0) {
      log.warn('No PI providers to route (empty discovery and no profile provider); PI subprocess may fail to authenticate');
      return;
    }
    writeProvidersConfig(overrides, gatewayBaseUrl, { modelsPath: piModelsPath(agentDir) });
  }

  private syncGatewayConfig(config: AgentSpawnConfig, agentDir: string, guard: BenchmarkGuard): void {
    const gatewayBaseUrl = config.piGatewayBaseUrl;
    if (!gatewayBaseUrl) return;
    this.prepareGatewayAgentDir(agentDir, guard);
    this.writeGatewayProviders(config, agentDir, gatewayBaseUrl, guard);
  }

  private prepareSpawn(config: AgentSpawnConfig): PreparedPISpawn {
    const guard = config.benchmarkPolicyGuard;
    if (guard !== undefined) assertBenchmarkSpawn(config, this.configuredAgentDir);
    const composition = resolveMcpComposition(config.mcpComposition, config.cortexContext?.useCoreMcp);
    const agentDir = this.configuredAgentDir ?? PI_AGENT_DIR;
    const sessionDir = this.sessionDir;
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = this.resolveSpawnSessionPath(config, sessionDir);
    const cliArgs = buildSpawnArgs(piSpawnOptions(config, sessionDir, sessionPath));
    this.syncGatewayConfig(config, agentDir, guard);
    const env = buildSpawnEnvironment(config, agentDir, composition);
    const cwd = config.cwd ?? DATA_DIR;
    return { sessionDir, cliArgs, cwd, env };
  }

  private quotaReporter(config: AgentSpawnConfig): ProviderQuotaReporter | undefined {
    if (!reportsProviderQuota(config)) return undefined;
    return (reading) => {
      void reportCodexQuota(reading, resolveQuotaSource(config))
        .catch((error) => log.error('reportCodexQuota error:', error));
    };
  }

  private createSession(config: AgentSpawnConfig, prepared: PreparedPISpawn): PISession {
    return new PISession({
      sessionKey: config.sessionKey,
      sessionDir: prepared.sessionDir,
      command: config.cliPath ?? DEFAULT_PI_BINARY,
      cliArgs: prepared.cliArgs,
      cwd: prepared.cwd,
      env: prepared.env,
      spawner: config.processSpawner ?? this.spawner,
      streamDeltas: config.streamDeltas ?? getSettings().streamDeltas,
      registry: this.sessionPathRegistry,
      registrySessionDir: prepared.sessionDir,
      onClose: (key) => this.sessions.delete(key),
      onProviderQuota: this.quotaReporter(config),
    });
  }

  private sendSpawnedTurn(session: PISession, msg: UserMessage): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve, reject) => {
      session.beginTurn(resolve, reject);
      const targetId = session.sessionId;
      if (targetId === null) {
        session.send(msg);
        return;
      }
      const targetPath = this.resolveSessionPath(targetId);
      session.sendTurn(targetId, targetPath, msg)
        .catch((error) => session.beginTurnReject(errorValue(error)));
    });
  }

  private async closeSpawnedSession(sessionKey: string, session: PISession): Promise<void> {
    await session.close();
    this.sessions.delete(sessionKey);
  }

  private killSpawnedSession(sessionKey: string, session: PISession): boolean {
    const killed = session.kill();
    if (killed) this.sessions.delete(sessionKey);
    return killed;
  }

  private createAgentProcess(sessionKey: string, session: PISession): PIAgentProcess {
    return {
      supervision: session.supervision,
      sessionKey,
      get sessionId(): string | null { return session.sessionId; },
      send: (msg) => this.sendSpawnedTurn(session, msg),
      compact: () => session.compact(),
      sendExtensionUiResponse: (id, payload) => session.sendExtensionUiResponse(id, payload),
      injectUserMessage: (msg) => session.injectUserMessage(msg),
      setInjectionAckSink: (sink) => session.setInjectionAckSink(sink),
      events: session.eventsIterable,
      close: () => this.closeSpawnedSession(sessionKey, session),
      kill: () => this.killSpawnedSession(sessionKey, session),
    };
  }

  spawn(config: AgentSpawnConfig): PIAgentProcess {
    const prepared = this.prepareSpawn(config);
    const session = this.createSession(config, prepared);
    this.sessions.set(config.sessionKey, session);

    return this.createAgentProcess(config.sessionKey, session);
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
