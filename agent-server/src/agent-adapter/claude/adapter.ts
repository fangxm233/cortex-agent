// input:  session streams, spawn config, reported accounting
// output: Claude turns with cache-inclusive input accounting
// pos:    Claude backend adapter
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { spawn, ChildProcess } from 'child_process';
import { createWriteStream, mkdirSync } from 'fs';
import { createInterface, Interface } from 'readline';
import { Writable } from 'stream';
import * as path from 'path';
import * as crypto from 'crypto';
import { DATA_DIR, readableTimestamp } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { handleRateLimitEvent } from '@domain/costs/rate-limit-throttle.js';
import type { IdentityJsonValue } from '@domain/agent-run/identity.js';
import { fromCanonical } from '../normalize/tool-names.js';
import { Capability, CAPABILITIES_BY_BACKEND } from '../capabilities.js';
import { resolveMcpComposition } from '../types.js';
import type {
  AgentAdapter, AgentCompactResult, AgentCompactUsage, AgentProcess, AgentProcessSpawner,
  AgentProcessSupervision, AgentSpawnConfig, Backend, ContinuationSink, InjectionAckSink,
  McpComposition, SpawnedAgentProcess, UserMessage,
} from '../types.js';
import type { AgentResult, ContextUsage, ReportedAccountingSnapshot } from '@core/types/agent-types.js';
import type { NormalizedEvent } from '../normalize/event-types.js';
import { createEventStream } from '../normalize/event-stream.js';
import {
  CancelledError,
  DEFAULT_TOOLS,
  IDLE_SESSION_TIMEOUT,
  LOGS_DIR,
  MAX_TIMEOUT,
  TURN_IDLE_TIMEOUT,
} from './defaults.js';
import { buildHooksSettings } from './hooks-builder.js';
import { buildClaudeEnv, buildSpawnArgs, ClaudeSpawnOptions, CortexAgentContext } from './spawn-args.js';
import { ClaudeTuiSession, defaultTailFactory, computeJsonlPath, resolveTuiResume, type ClaudeTuiSessionConfig } from './adapter-tui.js';
import { TmuxControl, type TmuxExec } from './tmux-control.js';
import { TUI_TMUX_NAME_PREFIX } from './defaults.js';
import {
  buildPrompt,
  clearActivePlanFile,
  extractAskUserQuestions,
  extractResult,
  formatEvent,
  getCurrentPlanFilePath,
  isPlanFilePath,
  mergeSubstantialOutput,
  setActivePlanFile,
  createStreamDeltaState,
  parseStreamEvent,
  takeTextBlockId,
  type StreamDeltaState,
} from './event-parser.js';
import { BgTaskTracker, routeLine } from './bg-task-tracker.js';
import { ClaudeContextUsageTracker } from './context-usage.js';
import { resolveAutoCompactWindow } from './compact-window.js';

const log = createLogger('claude-bridge');

function spawnClaudeProcess(
  spawner: AgentProcessSpawner | undefined,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  cliPath?: string,
): SpawnedAgentProcess {
  // One resolved command for both branches: a supervised trial and a direct spawn cannot run
  // different binaries (design §13 C2).
  const command = cliPath ?? 'claude';
  if (spawner) return spawner(command, args, options);
  return { process: spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }) };
}

// --- Persistent session ---

interface PendingTurn {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  resultData: any;
  planFilePath: string | null;
  enteredPlanMode: boolean;
  exitedPlanMode: boolean;
  askUserQuestions: any[];
  finalOutput: string | null;
  longestOutput: string | null;
  turnCount: number;
  onProgress: ((progress: any) => void) | null;
  /** Complete assistant text block. `blockId` ties it to the deltas that streamed it (absent when
   *  nothing streamed — kill switch, older CLI, or a reply that produced no partial messages). */
  onAssistantMessage: ((text: string, blockId?: string, model?: string | null) => void) | null;
  /** Incremental text chunk while a block is still being generated (never the accumulated total).
   *  Web UI preview only — the complete message above stays authoritative. */
  onAssistantDelta: ((text: string, blockId: string) => void) | null;
  onToolUse: ((name: string, input: any, toolUseId: string) => void) | null;
  onToolResult: ((toolUseId: string, content: string, isError: boolean) => void) | null;
  onCompact: ((info: { trigger: string; preTokens?: number }) => void) | null;
  onContextUsage: ((usage: ContextUsage) => void) | null;
  rawStream: Writable;
  txtStream: Writable;
  killed: boolean;
  /** True for a synthetic turn opened to capture a background-task continuation
   *  (the spontaneous turn the CLI emits after a run_in_background task finishes). */
  spontaneous?: boolean;
}

type ContinuationDelivery = (sink: ContinuationSink) => void;

type TurnTokenUsage = {
  input: number | null;
  output: number | null;
  cacheCreation: number | null;
  cacheRead: number | null;
};

function tokenValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function sumKnownTokens(values: unknown[]): number | null {
  const tokens = values.map(tokenValue);
  if (tokens.some(value => value === null)) return null;
  const total = tokens.reduce((sum, value) => sum + value!, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function promptAccounting(usage: TurnTokenUsage | null) {
  return {
    promptTokens: sumKnownTokens([
      usage?.input, usage?.cacheCreation, usage?.cacheRead,
    ]),
    cachedTokens: sumKnownTokens([usage?.cacheRead]),
  };
}

interface ClaudeSessionOptions {
  needsResume: boolean;
  model?: string | null;
  isUserInitiated?: boolean;
  callbackSource?: string | null;
  scheduleTaskId?: string | null;
  sessionKey?: string | null;
  claudeAgent?: string | null;
  systemPrompt?: string | null;
  appendSystemPrompt?: string | null;
  outputStyle?: string | null;
  tools?: string | null;
  pluginDirs?: string[] | null;
  anthropicBaseUrl?: string;
  extraEnv?: Record<string, string>;
  cwd?: string;
  mcpComposition?: McpComposition;
  mcpConfigPaths?: string[];
  disableHooks?: boolean;
  streamDeltas?: boolean;
  captureTranscriptLogs?: boolean;
  preserveUnreportedAccounting?: boolean;
  processSpawner?: AgentProcessSpawner;
  /** Absolute CLI path frozen by a trial policy; absent resolves `claude` from PATH. */
  cliPath?: string;
  /** Compiled benchmark policy guard; present replaces the ambient hook surface entirely. */
  benchmarkPolicyGuard?: IdentityJsonValue;
  /** Exact allowlisted child environment for a pinned trial. */
  pinnedEnv?: NodeJS.ProcessEnv;
  /** Extra CLI options from profile (e.g. {"--thinking": "xhigh"}). */
  extraOption?: Record<string, string>;
  /** Thinking level from the profile's `thinking` field → `--effort <level>`. Absent → no flag. */
  thinking?: string | null;
  /** Cortex execution context surfaced to the MCP server child as CORTEX_THREAD_ID/PROFILE/PROJECT/SESSION_NAME env vars.
   *  Captured at spawn time; later turns on the same session reuse the original snapshot. */
  context?: CortexAgentContext;
}

/** Single source of truth for ClaudeSession fields → ClaudeSpawnOptions CLI args translation.
 *  Used by both ClaudeSession.toSpawnOptions() (production) and _test.computeSpawnArgs (lock-in test). */
function deriveClaudeSpawnOptions(fields: {
  tools: string | null;
  systemPrompt: string | null;
  appendSystemPrompt: string | null;
  model: string | null;
  claudeAgent: string | null;
  pluginDirs: string[] | null;
  outputStyle: string | null;
  extraOption: Record<string, string> | undefined;
  thinking: string | null;
  needsResume: boolean;
  sessionId: string;
  mcpComposition: McpComposition;
  mcpConfigPaths?: string[];
  disableHooks?: boolean;
  benchmarkPolicyGuard?: IdentityJsonValue;
  streamDeltas?: boolean;
}): ClaudeSpawnOptions {
  return {
    tools: fields.tools,
    systemPrompt: fields.systemPrompt,
    appendSystemPrompt: fields.appendSystemPrompt,
    model: fields.model,
    claudeAgent: fields.claudeAgent,
    pluginDirs: fields.pluginDirs,
    outputStyle: fields.outputStyle,
    extraOption: fields.extraOption,
    thinking: fields.thinking,
    needsResume: fields.needsResume,
    sessionId: fields.sessionId,
    mcpComposition: fields.mcpComposition,
    mcpConfigPaths: fields.mcpConfigPaths,
    disableHooks: fields.disableHooks,
    benchmarkPolicyGuard: fields.benchmarkPolicyGuard,
    streamDeltas: fields.streamDeltas,
  };
}

/**
 * Extract the prompt text from a `--replay-user-messages` echo. `message.content` arrives either
 * as a bare string or as text blocks. Returns null for anything else — notably the tool_result
 * carriers print mode already emits as `user` lines, which must never be read as a prompt echo.
 */
export function extractReplayText(data: any): string | null {
  const content = data?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text as string);
  return parts.length ? parts.join('') : null;
}

class ClaudeSession {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  sessionId: string;
  private channel: string;
  private sessionKey: string;
  /** Model name requested via --model CLI arg (used as fallback for cost_record). */
  modelName: string | null;
  private isUserInitiated: boolean;
  private callbackSource: string | null;
  private scheduleTaskId: string | null;
  private claudeAgent: string | null;
  private systemPrompt: string | null;
  private appendSystemPrompt: string | null;
  private outputStyle: string | null;
  private tools: string | null;
  private pluginDirs: string[] | null;
  private anthropicBaseUrl: string | undefined;
  private extraEnv: Record<string, string> | undefined;
  private cwd: string;
  private mcpComposition: McpComposition;
  private mcpConfigPaths: string[] | undefined;
  private disableHooks: boolean;
  private streamDeltas: boolean | undefined;
  private captureTranscriptLogs: boolean;
  private preserveUnreportedAccounting: boolean;
  private processSpawner: AgentProcessSpawner | undefined;
  private cliPath: string | undefined;
  private benchmarkPolicyGuard: IdentityJsonValue | undefined;
  private pinnedEnv: NodeJS.ProcessEnv | undefined;
  private supervision: AgentProcessSupervision | undefined;
  private extraOption: Record<string, string> | undefined;
  private thinking: string | null;
  private context: CortexAgentContext | undefined;
  private currentTurn: PendingTurn | null = null;
  /** Cursor over the `stream_event` sequence (--include-partial-messages). Session-scoped rather
   *  than turn-scoped because the stream is a property of the process, and every `message_start`
   *  resets it anyway. */
  private streamDeltaState: StreamDeltaState = createStreamDeltaState();
  /** Current provider-call usage plus configured/result-reconciled context window. */
  private contextUsageTracker: ClaudeContextUsageTracker;
  /** Tracks in-flight background tasks (run_in_background) for this session. */
  private bgTracker = new BgTaskTracker();
  /** Set by orchestration to receive spontaneous background-task continuation turns. */
  private continuationSink: ContinuationSink | null = null;
  /** One-shot events that arrived before completion-only waiting installed its sink. */
  private pendingContinuationDeliveries: ContinuationDelivery[] = [];
  /** Messages injected into an in-flight turn that the CLI has not echoed back yet, in write
   *  order. Each is popped by its `--replay-user-messages` echo (the delivery ack). */
  private pendingInjections: { prompt: string; text: string }[] = [];
  /** Set by orchestration to receive injection delivery acks. */
  private injectionAck: InjectionAckSink | null = null;
  /** Set when an injected message was consumed with NO turn in flight — the CLI is about to start
   *  a turn of its own for it. Consumed by the next assistant line, which opens the
   *  synthetic turn that captures the reply. */
  private injectionContinuationArmed = false;
  private alive: boolean = false;
  private needsResume: boolean;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private turnIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private stderr: string = '';
  private cumulativeCostUsd: number = 0;
  /** Captured from result event's modelUsage key for cost_record. */
  lastModelName: string | null = null;
  /** Captured from result event's usage for legacy cost_record and compact accounting. */
  lastTokenUsage: TurnTokenUsage | null = null;

  constructor(channel: string, sessionId: string, options: ClaudeSessionOptions) {
    this.channel = channel;
    this.sessionId = sessionId;
    this.sessionKey = options.sessionKey || channel;
    this.needsResume = options.needsResume;
    this.modelName = options.model || null;
    this.cwd = options.cwd ?? DATA_DIR;
    // Settings are read per session because the CLI reads project settings from its spawn cwd.
    this.contextUsageTracker = new ClaudeContextUsageTracker(
      this.modelName,
      resolveAutoCompactWindow(this.cwd),
    );
    this.isUserInitiated = options.isUserInitiated || false;
    this.callbackSource = options.callbackSource || null;
    this.scheduleTaskId = options.scheduleTaskId || null;
    this.claudeAgent = options.claudeAgent || null;
    this.systemPrompt = options.systemPrompt || null;
    this.appendSystemPrompt = options.appendSystemPrompt ?? null;
    this.outputStyle = options.outputStyle || null;
    this.tools = options.tools || null;
    this.pluginDirs = options.pluginDirs || null;
    this.anthropicBaseUrl = options.anthropicBaseUrl;
    this.extraEnv = options.extraEnv;
    this.mcpComposition = resolveMcpComposition(options.mcpComposition, options.context?.useCoreMcp);
    this.mcpConfigPaths = options.mcpConfigPaths;
    this.disableHooks = options.disableHooks === true;
    this.streamDeltas = options.streamDeltas;
    this.captureTranscriptLogs = options.captureTranscriptLogs !== false;
    this.preserveUnreportedAccounting = options.preserveUnreportedAccounting === true;
    this.processSpawner = options.processSpawner;
    this.cliPath = options.cliPath;
    this.benchmarkPolicyGuard = options.benchmarkPolicyGuard;
    this.pinnedEnv = options.pinnedEnv;
    this.extraOption = options.extraOption;
    this.thinking = options.thinking ?? null;
    this.context = options.context;
    this.spawnProcess();
  }

  private toSpawnOptions(): ClaudeSpawnOptions {
    return deriveClaudeSpawnOptions({
      tools: this.tools,
      systemPrompt: this.systemPrompt,
      appendSystemPrompt: this.appendSystemPrompt,
      model: this.modelName,
      claudeAgent: this.claudeAgent,
      pluginDirs: this.pluginDirs,
      outputStyle: this.outputStyle,
      extraOption: this.extraOption,
      thinking: this.thinking,
      needsResume: this.needsResume,
      sessionId: this.sessionId,
      mcpComposition: this.mcpComposition,
      mcpConfigPaths: this.mcpConfigPaths,
      disableHooks: this.disableHooks,
      benchmarkPolicyGuard: this.benchmarkPolicyGuard,
      streamDeltas: this.streamDeltas,
    });
  }

  matchesSpawn(cwd: string, composition: McpComposition): boolean {
    return this.cwd === cwd && this.mcpComposition === composition;
  }

  private handleProcessClose(code: number | null): void {
    log.info(`Process closed: ${this.sessionId.substring(0, 8)} code=${code}`);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
    this.idleTimer = null;
    this.maxTimer = null;
    this.turnIdleTimer = null;
    this.alive = false;
    clearActivePlanFile(this.sessionId);
    if (this.currentTurn) {
      const turn = this.currentTurn;
      this.currentTurn = null;
      this.closeTurnLogs(turn);
      if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
      if (turn.spontaneous) {
        // The process died mid-continuation. The spontaneous turn has no awaiting caller —
        // its reject would only log — so deliver the interruption to the sink directly
        // (single-fire; the resolve path never ran because no result event arrived).
        this.notifyBgInterrupted(true);
      } else if (turn.killed) {
        turn.reject(new CancelledError());
      } else {
        const result = extractResult(turn.resultData, this.sessionId, false, code || 1, this.stderr,
          turn.planFilePath, turn.enteredPlanMode, turn.exitedPlanMode, turn.askUserQuestions,
          turn.finalOutput, turn.longestOutput);
        if (result.resolved) turn.resolve(result.value);
        else turn.reject(result.error);
      }
    }
    // Waiting-window case (no active turn, background tasks pending): the held status would
    // otherwise wait forever — any process death (restart / crash / kill / timeout) must
    // seal it. No-op when nothing is pending; always releases the sink (session is gone).
    this.notifyBgInterrupted();
    if (sessions.get(this.sessionKey) === this) sessions.delete(this.sessionKey);
  }

  /** Deliver a synthetic interrupted result to the continuation sink (single-fire: the sink
   *  reference is cleared before invoking). Fires only when background work may still produce
   *  a continuation (or `force`, for a dying spontaneous turn); otherwise just clears the sink. */
  private notifyBgInterrupted(force = false): void {
    const sink = this.continuationSink;
    if (!sink) return;
    this.continuationSink = null;
    // An injected message that was never echoed back, or one already consumed into a spontaneous
    // turn that never arrived, is work the caller is still waiting on — seal it like pending
    // background work rather than dropping the sink silently.
    const injectionOutstanding = this.pendingInjections.length > 0 || this.injectionContinuationArmed;
    if (!force && !this.bgTracker.hasPending() && !this.bgTracker.continuationArmed && !injectionOutstanding) return;
    const result: AgentResult = {
      sessionId: this.sessionId,
      total_cost_usd: null, num_turns: null,
      rateLimited: false, rateLimitMessage: null,
      planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
      finalOutput: null,
      pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0,
      backgroundInterrupted: true,
    };
    try { sink.onResult(result); } catch (e) { log.warn('bg-interrupted sink onResult threw:', (e as Error).message); }
  }

  private spawnProcess(): void {
    const env = buildClaudeEnv(this.channel, this.sessionId, this.callbackSource, this.scheduleTaskId, this.anthropicBaseUrl, this.extraEnv, this.context, this.pinnedEnv);
    const spawnOptions = this.toSpawnOptions();
    // Sessions that originate from Slack (channel carries the SlackAdapter `slack:` prefix) load the
    // cortex-slack MCP server so the agent can send files to Slack. Non-direct compositions suppress it.
    spawnOptions.loadSlackMcp = this.channel.startsWith('slack:');
    // Sessions that originate from Feishu (channel carries the FeishuAdapter `feishu:` prefix) load the
    // cortex-feishu MCP server so the agent can read/write Feishu documents. Non-direct compositions suppress it.
    spawnOptions.loadFeishuMcp = this.channel.startsWith('feishu:');
    // Sessions that originate from the Web UI (channel carries the `web:` prefix) load the cortex-web
    // MCP server so the agent can send files into the chat via send_file. Non-direct compositions suppress it.
    spawnOptions.loadWebMcp = this.channel.startsWith('web:');
    // User-message-initiated direct print sessions get the cortex-tui-bridge interaction tools;
    // non-direct compositions suppress them.
    spawnOptions.isUserInitiated = this.isUserInitiated;
    const args = buildSpawnArgs(spawnOptions);
    log.info(`Spawning persistent process: ${this.sessionId.substring(0, 8)} ${this.needsResume ? '(resume)' : '(new)'}`);

    const spawned = spawnClaudeProcess(this.processSpawner, args, { cwd: this.cwd, env }, this.cliPath);
    this.proc = spawned.process;
    this.supervision = spawned.supervision;
    this.stderr = '';
    this.rl = createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.handleLine(line));
    this.proc.stderr!.on('data', (d) => { this.stderr += d.toString(); });
    this.proc.on('close', (code) => this.handleProcessClose(code));

    this.alive = true;
    this.resetIdleTimer();
    this.maxTimer = setTimeout(() => {
      log.info(`Session ${this.sessionId.substring(0, 8)} hit max timeout, killing`);
      this.kill();
    }, MAX_TIMEOUT);
  }

  private createTurnStreams(userMessage: string): { rawStream: Writable; txtStream: Writable } {
    if (!this.captureTranscriptLogs) {
      const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
      return { rawStream: sink(), txtStream: sink() };
    }
    mkdirSync(LOGS_DIR, { recursive: true });
    const ts = readableTimestamp();
    const rawStream = createWriteStream(path.join(LOGS_DIR, `claude-output-${ts}.jsonl`), { flags: 'a' });
    const txtStream = createWriteStream(path.join(LOGS_DIR, `claude-output-${ts}.txt`), { flags: 'a' });
    txtStream.write(`=== Cortex session started at ${new Date().toISOString()} ===\n=== channel=${this.channel}, session=${this.sessionId} ===\n\n`);
    txtStream.write(`[user-input] ${userMessage}\n\n`);
    return { rawStream, txtStream };
  }

  private registerTurn(resolve: any, reject: any, streams: { rawStream: Writable; txtStream: Writable }, options: any): void {
    clearActivePlanFile(this.sessionId);
    this.currentTurn = {
      resolve, reject,
      resultData: null,
      planFilePath: null,
      enteredPlanMode: false,
      exitedPlanMode: false,
      askUserQuestions: [],
      finalOutput: null,
      longestOutput: null,
      turnCount: 0,
      onProgress: options.onProgress || null,
      onAssistantMessage: options.onAssistantMessage || null,
      onAssistantDelta: options.onAssistantDelta || null,
      onToolUse: options.onToolUse || null,
      onToolResult: options.onToolResult || null,
      onCompact: options.onCompact || null,
      onContextUsage: options.onContextUsage || null,
      rawStream: streams.rawStream,
      txtStream: streams.txtStream,
      killed: false,
    };
  }

  private deliverContinuation(delivery: ContinuationDelivery): void {
    const sink = this.continuationSink;
    if (!sink) {
      if (this.preserveUnreportedAccounting) this.pendingContinuationDeliveries.push(delivery);
      return;
    }
    try { delivery(sink); }
    catch (error) { log.warn('continuation sink threw:', (error as Error).message); }
  }

  /** Register/replace the continuation sink. Persists across normal turns; lives as long
   *  as the pooled session, until close()/kill(). */
  setContinuationSink(sink: ContinuationSink): void {
    this.continuationSink = sink;
    const pending = this.pendingContinuationDeliveries.splice(0);
    for (const delivery of pending) this.deliverContinuation(delivery);
  }

  clearContinuationSink(): void {
    this.continuationSink = null;
    this.pendingContinuationDeliveries.length = 0;
  }

  /** Register/replace the injection delivery-ack sink. Lifetime mirrors continuationSink. */
  setInjectionAckSink(sink: InjectionAckSink): void {
    this.injectionAck = sink;
  }

  clearInjectionAckSink(): void {
    this.injectionAck = null;
  }

  /**
   * Deliver a user message into the turn already in flight.
   *
   * Writes the SAME NDJSON user line a normal turn writes, but registers NO turn: the message is
   * absorbed by the run already in progress, so the already-awaited turn promise covers it and no
   * second result is fabricated. Cost/turn accounting stays with the running turn.
   *
   * Where it lands is a race the caller cannot control, so both outcomes are wired here:
   *   - tool-result boundary → folds into the running turn, ONE result. Nothing extra
   *     to do; the turn's own callbacks carry the reply.
   *   - mid-text-generation → the CLI drains its queue only after this turn's result and then
   *     starts a turn of its own. The echo handler arms the existing spontaneous-turn
   *     path so that reply is captured by continuationSink instead of dropped.
   *
   * Returns false when there is no live process or no active turn — the caller then falls back to
   * the normal queue.
   */
  injectUserMessage(message: UserMessage): boolean {
    if (!this.alive || !this.proc?.stdin) return false;
    // No turn in flight ⇒ nothing to inject INTO. A message written here would open an untracked
    // turn whose reply nobody is awaiting; the caller must enqueue it as a normal turn instead.
    if (!this.currentTurn) return false;

    const files = (message.attachments || []).map((a) => ({
      mimetype: a.mimeType, localPath: a.path, name: path.basename(a.path),
    }));
    const prompt = buildPrompt(message.text, files);
    try {
      this.writeTurnStdin(prompt);
    } catch {
      // writeTurnStdin already marked the session dead and rejected the in-flight turn — the pipe
      // is gone, so report "cannot inject" rather than propagating into the caller's routing.
      return false;
    }
    this.pendingInjections.push({ prompt, text: message.text });
    this.resetIdleTimer();
    this.bumpTurnIdleTimer();
    log.info(`Injected mid-turn message into ${this.sessionId.substring(0, 8)} (${prompt.length} chars)`);
    return true;
  }

  /**
   * Handle a `--replay-user-messages` echo. The CLI echoes EVERY user message, so most echoes are
   * the turn's own opening prompt and must be ignored; only an echo matching the head of the
   * pending-injection queue is a delivery ack. Nothing else in the system reads these events.
   */
  private handleReplayEcho(data: any): void {
    const text = extractReplayText(data);
    if (text === null) return;
    const head = this.pendingInjections[0];
    if (!head || head.prompt !== text) return; // the turn's own prompt (or a tool_result carrier)
    this.pendingInjections.shift();
    // Consumed with no turn in flight ⇒ this is the post-result outcome: the CLI is starting a turn
    // of its own. Arm the spontaneous-turn capture before its first assistant line arrives.
    const foldedIntoTurn = !!this.currentTurn;
    if (!foldedIntoTurn) this.injectionContinuationArmed = true;
    const ack = this.injectionAck;
    if (!ack) return;
    try { ack.onDelivered({ text: head.text, foldedIntoTurn }); }
    catch (e) { log.warn('injection onDelivered threw:', (e as Error).message); }
  }

  private continuationCallbacks() {
    return {
      resolve: (value: any) => this.deliverContinuation(sink => sink.onResult(value as AgentResult)),
      reject: (error: Error) => log.warn('continuation turn rejected:', error?.message ?? String(error)),
      onAssistantMessage: (text: string, _blockId?: string, model?: string | null) =>
        this.deliverContinuation(sink => sink.onAssistantText(text, model)),
      onToolUse: (name: string, input: any, id: string) =>
        this.deliverContinuation(sink => sink.onToolUse?.(name, input, id)),
      onToolResult: (id: string, content: string, isError: boolean) =>
        this.deliverContinuation(sink => sink.onToolResult?.(id, content, isError)),
      onContextUsage: (usage: ContextUsage) =>
        this.deliverContinuation(sink => sink.onContextUsage?.(usage)),
    };
  }

  /** Open a synthetic turn to capture the spontaneous continuation the CLI emits after a
   *  background task finishes. Its output is delivered or buffered for continuationSink. */
  private openContinuationTurn(label = '[background-task continuation]'): void {
    this.bgTracker.disarmContinuation();
    const streams = this.createTurnStreams(label);
    this.currentTurn = {
      ...this.continuationCallbacks(),
      resultData: null, planFilePath: null,
      enteredPlanMode: false, exitedPlanMode: false,
      askUserQuestions: [], finalOutput: null, longestOutput: null, turnCount: 0,
      onProgress: null, onAssistantDelta: null, onCompact: null,
      rawStream: streams.rawStream, txtStream: streams.txtStream,
      killed: false, spontaneous: true,
    };
  }

  private writeTurnStdin(prompt: string): void {
    const stdinMsg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: prompt },
      session_id: this.sessionId,
    }) + '\n';
    try {
      this.proc!.stdin!.write(stdinMsg);
    } catch (e: any) {
      this.alive = false;
      if (this.currentTurn) {
        const turn = this.currentTurn;
        this.currentTurn = null;
        this.closeTurnLogs(turn);
        turn.reject(new Error(`Failed to write to claude stdin: ${e.message}`));
      }
      sessions.delete(this.sessionKey);
      throw new Error(`Claude process stdin write failed: ${e.message}`);
    }
  }

  private startTurnIdleTimer(): void {
    this.turnIdleTimer = setTimeout(() => {
      log.info(`Session ${this.sessionId.substring(0, 8)} turn idle for 60min, killing`);
      this.kill();
    }, TURN_IDLE_TIMEOUT);
  }

  async sendMessage(userMessage: string, options: {
    files?: any[];
    callbackSource?: string | null;
    scheduleTaskId?: string | null;
    isUserInitiated?: boolean;
    onProgress?: ((progress: any) => void) | null;
    onAssistantMessage?: ((text: string, blockId?: string, model?: string | null) => void) | null;
    onAssistantDelta?: ((text: string, blockId: string) => void) | null;
    onToolUse?: ((name: string, input: any, toolUseId: string) => void) | null;
    onToolResult?: ((toolUseId: string, content: string, isError: boolean) => void) | null;
    onCompact?: ((info: { trigger: string; preTokens?: number }) => void) | null;
    onContextUsage?: ((usage: ContextUsage) => void) | null;
  }): Promise<any> {
    if (!this.alive) {
      this.needsResume = true;
      this.spawnProcess();
    }
    this.resetIdleTimer();
    const prompt = buildPrompt(userMessage, options.files || []);
    const streams = this.createTurnStreams(userMessage);

    const turnPromise = new Promise<any>((resolve, reject) => {
      this.registerTurn(resolve, reject, streams, options);
    });

    this.writeTurnStdin(prompt);
    this.startTurnIdleTimer();

    const result = await turnPromise;
    if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
    this.turnIdleTimer = null;
    this.resetIdleTimer();
    return result;
  }

  /** Invoke Claude Code's local slash handler without recording a Cortex user turn. */
  async compact(): Promise<AgentCompactResult> {
    let confirmed = false;
    let tokensBefore: number | null = null;
    const result = await this.sendMessage('/compact', {
      onCompact: (info) => {
        confirmed = true;
        tokensBefore = typeof info.preTokens === 'number' ? info.preTokens : null;
      },
    });
    if (result.finalOutput?.trim() === 'Error: No messages to compact') {
      return {
        status: 'not-needed', tokensBefore: null, estimatedTokensAfter: null,
        contextUsage: null, usage: null,
      };
    }
    if (!confirmed) throw new Error('Claude did not confirm compaction with compact_boundary');
    return {
      status: 'compacted', tokensBefore, estimatedTokensAfter: null,
      contextUsage: null, usage: this.compactUsage(result),
    };
  }

  private compactUsage(result: AgentResult): AgentCompactUsage | null {
    const tokens = this.lastTokenUsage;
    if (!tokens && !result.total_cost_usd) return null;
    return {
      inputTokens: tokens?.input ?? 0,
      outputTokens: tokens?.output ?? 0,
      cacheReadTokens: tokens?.cacheRead ?? 0,
      cacheWriteTokens: tokens?.cacheCreation ?? 0,
      costUsd: result.total_cost_usd,
    };
  }

  private bumpTurnIdleTimer(): void {
    if (!this.turnIdleTimer) return;
    clearTimeout(this.turnIdleTimer);
    this.startTurnIdleTimer();
  }

  private turnCost(data: any): number {
    if (data.total_cost_usd == null) return 0;
    const cumulativeCost = data.total_cost_usd;
    const turnCost = cumulativeCost - this.cumulativeCostUsd;
    this.cumulativeCostUsd = cumulativeCost;
    return turnCost > 0 ? turnCost : 0;
  }

  private captureTurnAccounting(data: any): number {
    const missingToken = this.preserveUnreportedAccounting ? null : 0;
    this.lastTokenUsage = data.usage ? {
      input: data.usage.input_tokens ?? missingToken,
      output: data.usage.output_tokens ?? missingToken,
      cacheCreation: data.usage.cache_creation_input_tokens ?? missingToken,
      cacheRead: data.usage.cache_read_input_tokens ?? missingToken,
    } : null;
    const models = data.modelUsage ? Object.keys(data.modelUsage) : [];
    this.lastModelName = models[0] ?? null;
    return this.turnCost(data);
  }

  private reportedAccounting(data: any): ReportedAccountingSnapshot {
    const usage = data.usage;
    const turnUsage = usage ? {
      input: tokenValue(usage.input_tokens),
      output: tokenValue(usage.output_tokens),
      cacheCreation: tokenValue(usage.cache_creation_input_tokens),
      cacheRead: tokenValue(usage.cache_read_input_tokens),
    } : null;
    return {
      usageReported: usage != null,
      inputTokens: turnUsage?.input ?? null,
      outputTokens: turnUsage?.output ?? null,
      ...promptAccounting(turnUsage),
      model: data.modelUsage ? Object.keys(data.modelUsage)[0] ?? null : null,
    };
  }

  private settleResultTurn(
    turn: PendingTurn, data: any, result: ReturnType<typeof extractResult>,
  ): void {
    if (result.resolved) {
      const value = result.value as AgentResult;
      if (this.preserveUnreportedAccounting) {
        value.costReported = data.total_cost_usd != null;
        value.reportedAccounting = this.reportedAccounting(data);
      }
      value.pendingBackgroundTasks = this.bgTracker.pendingCount;
      value.undeliveredBackgroundTasks = this.bgTracker.undeliveredCount;
    }
    this.currentTurn = null;
    if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
    this.turnIdleTimer = null;
    const formatted = formatEvent(data);
    if (formatted) turn.txtStream.write(formatted + '\n');
    turn.txtStream.write(`\n=== Turn finished at ${new Date().toISOString()} ===\n`);
    turn.rawStream.end();
    turn.txtStream.end();
    if (result.resolved) turn.resolve(result.value);
    else turn.reject(result.error);
  }

  private handleResultEvent(turn: PendingTurn, data: any): void {
    turn.resultData = { ...data, total_cost_usd: this.captureTurnAccounting(data) };
    const result = extractResult(turn.resultData, this.sessionId, false, 0, '',
      turn.planFilePath, turn.enteredPlanMode, turn.exitedPlanMode, turn.askUserQuestions,
      turn.finalOutput, turn.longestOutput);
    this.settleResultTurn(turn, data, result);
  }

  /** Preserve the complete result carrier that print mode emits as a `user` content block. */
  private handleToolResultEvent(turn: PendingTurn, data: any): void {
    if (typeof turn.onToolResult !== 'function') return;
    const content = data.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || block.type !== 'tool_result') continue;
      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      let resultContent: string;
      if (typeof block.content === 'string') {
        resultContent = block.content;
      } else if (Array.isArray(block.content)) {
        const allText = block.content.every((item: any) => item?.type === 'text' && typeof item.text === 'string');
        resultContent = allText
          ? block.content.map((item: any) => item.text).join('\n')
          : JSON.stringify(block.content);
      } else {
        resultContent = JSON.stringify(block.content ?? '');
      }
      try { turn.onToolResult(toolUseId, resultContent, block.is_error === true); }
      catch (e) { log.warn('onToolResult threw:', (e as Error).message); }
    }
  }

  private handleAssistantToolBlock(turn: PendingTurn, block: any): void {
    if (block.name === 'Write' && isPlanFilePath(block.input?.file_path)) {
      turn.planFilePath = block.input.file_path;
      setActivePlanFile(this.sessionId, block.input.file_path);
    }
    if (block.name === 'EnterPlanMode') turn.enteredPlanMode = true;
    if (block.name === 'ExitPlanMode') turn.exitedPlanMode = true;
    if (typeof turn.onToolUse !== 'function') return;
    try {
      turn.onToolUse(block.name || '?', block.input || {}, typeof block.id === 'string' ? block.id : '');
    } catch (error) {
      log.warn('onToolUse threw:', (error as Error).message);
    }
  }

  private handleAssistantTextBlock(turn: PendingTurn, data: any, block: any): void {
    if (!block.text) return;
    turn.finalOutput = block.text;
    if (block.text.length > (turn.longestOutput?.length || 0)) turn.longestOutput = block.text;
    const blockId = takeTextBlockId(this.streamDeltaState) ?? undefined;
    const streamedModel = this.streamDeltaState.messageId === data.message?.id
      ? this.streamDeltaState.model
      : null;
    const model = typeof data.message?.model === 'string' ? data.message.model : streamedModel;
    turn.onAssistantMessage?.(block.text, blockId, model);
  }

  private handleAssistantEvent(turn: PendingTurn, data: any): void {
    turn.turnCount += 1;
    for (const block of (data.message?.content || [])) {
      if (block.type === 'tool_use') this.handleAssistantToolBlock(turn, block);
      if (block.type === 'text') this.handleAssistantTextBlock(turn, data, block);
    }
    turn.onProgress?.({ num_turns: turn.turnCount, total_cost_usd: null, duration_ms: null });
  }

  private emitContextUsage(data: unknown): void {
    const usage = this.contextUsageTracker.observe(data);
    const callback = this.currentTurn?.onContextUsage;
    if (!usage || typeof callback !== 'function') return;
    try { callback(usage); }
    catch (e) { log.warn('onContextUsage threw:', (e as Error).message); }
  }

  private handleLine(line: string) {
    if (!line) return;
    this.resetIdleTimer();
    this.bumpTurnIdleTimer();

    let parsed: any;
    let isJson = false;
    try { parsed = JSON.parse(line); isJson = true; } catch { /* handled below */ }

    // `stream_event` lines are the token-level preview of a block the CLI will also deliver
    // complete. They dominate stdout once --include-partial-messages is on (measured: 74-86% of
    // all lines), and everything they carry is repeated verbatim by the complete event, so they
    // are deliberately kept out of the per-turn raw jsonl and the daemon log. Handled first, and
    // separately, because everything below is about complete events.
    if (isJson && parsed?.type === 'stream_event') {
      this.emitContextUsage(parsed);
      const delta = parseStreamEvent(parsed, this.streamDeltaState);
      if (delta && typeof this.currentTurn?.onAssistantDelta === 'function') {
        try { this.currentTurn.onAssistantDelta(delta.text, delta.blockId); }
        catch (e) { log.warn('onAssistantDelta threw:', (e as Error).message); }
      }
      return;
    }

    if (this.currentTurn?.rawStream) this.currentTurn.rawStream.write(line + '\n');

    try {
      const data = parsed;
      if (!isJson) throw new Error('not json');
      // Context compaction boundary: invalidate the old provider-call cursor immediately, then
      // surface the boundary to the active turn so observers (e.g. Slack) can notify.
      if (data.type === 'system' && data.subtype === 'compact_boundary') this.emitContextUsage(data);
      if (data.type === 'system' && data.subtype === 'compact_boundary' && this.currentTurn?.onCompact) {
        const meta = data.compact_metadata ?? {};
        try {
          this.currentTurn.onCompact({
            trigger: typeof meta.trigger === 'string' ? meta.trigger : 'auto',
            preTokens: typeof meta.pre_tokens === 'number' ? meta.pre_tokens : undefined,
          });
        } catch (e) { log.warn('onCompact threw:', (e as Error).message); }
      }
      if (data.type === 'rate_limit_event' && data.rate_limit_info) {
        const mode = this.anthropicBaseUrl?.match(/\/m\/([^/]+)\//)?.[1] || undefined;
        handleRateLimitEvent(data.rate_limit_info, {
          provider: 'anthropic', displayName: 'Anthropic', mode,
        }).catch(e => log.error('handleRateLimitEvent error:', e));
      }
      // `--replay-user-messages` echo: the CLI's delivery ack for an injected message.
      // Handled here and nowhere else — it is deliberately NOT fed to turn bookkeeping, background
      // tracking, or conversation history (a `user` record there would shift every later turn
      // index and break edit/rewind). Replays are inert for every other consumer.
      if (data.type === 'user' && data.isReplay) this.handleReplayEcho(data);
      if (data.type === 'user' && !data.isReplay && this.currentTurn) this.handleToolResultEvent(this.currentTurn, data);
      // Track background-task lifecycle on every line (even with no active turn) so the
      // pending count stays accurate across the turn boundary.
      this.bgTracker.observe(data);
      // No active turn, and the model just started speaking anyway: either a background task
      // finished (bgTracker armed) or an injected message was consumed after this turn's result
      // Both make the CLI open a turn of its own — open a synthetic turn for it so its
      // output is routed (to continuationSink) instead of being dropped.
      const canCaptureContinuation = this.continuationSink || this.preserveUnreportedAccounting;
      if (!this.currentTurn && canCaptureContinuation && data.type === 'assistant'
          && (this.injectionContinuationArmed || routeLine(this.bgTracker, data, false) === 'open-continuation')) {
        const fromInjection = this.injectionContinuationArmed;
        this.injectionContinuationArmed = false;
        this.openContinuationTurn(fromInjection ? '[injected-message continuation]' : '[background-task continuation]');
      }
      if (data.type === 'result' && this.currentTurn) {
        this.emitContextUsage(data);
        this.handleResultEvent(this.currentTurn, data);
        return;
      }
      if (data.type === 'assistant' && this.currentTurn) this.handleAssistantEvent(this.currentTurn, data);
      const formatted = formatEvent(data);
      if (formatted && this.currentTurn?.txtStream) this.currentTurn.txtStream.write(formatted + '\n');
    } catch {
      if (this.currentTurn?.txtStream) this.currentTurn.txtStream.write(`[raw] ${line}\n`);
    }
    log.info('stream:', line.substring(0, 200));
  }

  private closeTurnLogs(turn: PendingTurn) {
    try {
      turn.txtStream.write(`\n=== Turn ended at ${new Date().toISOString()} ===\n`);
      turn.rawStream.end();
      turn.txtStream.end();
    } catch {}
  }

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // While background tasks are still running — or an injected message is queued inside the CLI
    // awaiting its spontaneous turn — the session must stay alive to receive the continuation,
    // even through a long silent wait. Don't arm idle-close (the overall maxTimer still bounds
    // session lifetime).
    if (this.bgTracker.hasPending() || this.pendingInjections.length > 0 || this.injectionContinuationArmed) {
      this.idleTimer = null;
      return;
    }
    this.idleTimer = setTimeout(() => {
      log.info(`Session ${this.sessionId.substring(0, 8)} idle for 65min, closing`);
      this.close();
    }, IDLE_SESSION_TIMEOUT);
  }

  close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
    // Do NOT clear continuationSink here: if background tasks are pending, the process
    // 'close' event (handleProcessClose) must still deliver the interruption to the sink
    // so the held "background task running" status seals instead of waiting forever.
    if (!this.proc || !this.alive) {
      // Process already gone (or never spawned): no 'close' event will come — seal now.
      this.notifyBgInterrupted();
      sessions.delete(this.sessionKey);
      return;
    }
    this.alive = false;
    sessions.delete(this.sessionKey);

    try {
      this.proc.stdin!.end();
    } catch {}

    const graceTimer = setTimeout(() => {
      if (this.proc && this.proc.exitCode === null) {
        try { this.proc.kill('SIGTERM'); } catch {}
        setTimeout(() => {
          if (this.proc && this.proc.exitCode === null) {
            try { this.proc.kill('SIGKILL'); } catch {}
          }
        }, 10_000);
      }
    }, 30_000);

    this.proc.on('close', () => clearTimeout(graceTimer));
  }

  kill(): boolean {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
    // Sink intentionally NOT cleared: handleProcessClose (via the SIGTERM 'close' event)
    // delivers the background-task interruption to it, then clears it.
    if (!this.proc || this.proc.exitCode !== null) return false;
    this.alive = false;
    if (sessions.get(this.sessionKey) === this) sessions.delete(this.sessionKey);
    if (this.currentTurn) this.currentTurn.killed = true;
    if (this.supervision) {
      this.supervision.cancel('cancel');
      return true;
    }
    try { this.proc.kill('SIGTERM'); return true; } catch { return false; }
  }

  getSupervision(): AgentProcessSupervision | undefined {
    return this.supervision;
  }

  isAlive(): boolean {
    return this.alive;
  }
}

// --- Session pool ---

const sessions = new Map<string, ClaudeSession>();

function getOrCreateSession(channel: string, sessionId: string, options: ClaudeSessionOptions): ClaudeSession {
  const key = options.sessionKey || channel;
  const cwd = options.cwd ?? DATA_DIR;
  const composition = resolveMcpComposition(options.mcpComposition, options.context?.useCoreMcp);
  let session = sessions.get(key);

  const incompatible = session && !session.matchesSpawn(cwd, composition);
  if (!session || !session.isAlive() || incompatible || (options.needsResume && session.sessionId !== sessionId)) {
    if (session) session.close();
    session = new ClaudeSession(channel, sessionId, { ...options, sessionKey: key });
    sessions.set(key, session);
  }

  return session;
}

export function closeSession(channel: string, sessionKey?: string): void {
  const key = sessionKey || channel;
  const session = sessions.get(key);
  if (session) session.close();
}

/** Hard-stop the pooled session for a channel (SIGTERM, same path the foreground Stop takes via
 *  handle.kill()). Unlike closeSession's graceful stdin-end + 30s grace, this ends the process now
 *  — used by the Stop path to actually kill background tasks still running inside it after the
 *  foreground turn ended. Returns false when no live session exists for the key. */
export function killSession(channel: string, sessionKey?: string): boolean {
  const session = sessions.get(sessionKey || channel);
  return session ? session.kill() : false;
}

/** Close all sessions whose key starts with the given prefix (used by Thread cleanup). */
export function closeSessionsByPrefix(prefix: string): void {
  for (const [key, session] of sessions) {
    if (key.startsWith(prefix)) session.close();
  }
}

export function closeAllSessions(): void {
  for (const [, session] of sessions) session.close();
  sessions.clear();
}

// --- runClaude (legacy top-level API, unchanged signature) ---

export interface RunClaudeOptions {
  channel: string;
  sessionId?: string | null;
  files?: any[];
  callbackSource?: string | null;
  scheduleTaskId?: string | null;
  model?: string | null;
  isUserInitiated?: boolean;
  onProgress?: any;
  onAssistantMessage?: any;
  onToolUse?: ((name: string, input: any, toolUseId: string) => void) | null;
  onToolResult?: ((toolUseId: string, content: string, isError: boolean) => void) | null;
  sessionKey?: string | null;
  claudeAgent?: string | null;
  systemPrompt?: string | null;
  outputStyle?: string | null;
  tools?: string | null;
  pluginDirs?: string[] | null;
  anthropicBaseUrl?: string;
}

/**
 * Decide whether a print-mode ClaudeSession should spawn with `--resume <id>`.
 *
 * Print sessions default to `DATA_DIR` and may receive an explicit cwd, so transcript lookup uses
 * the same resolved cwd as the process spawn. A *fresh* session (notably the `cortex tui`
 * frontend) pre-registers its sessionId BEFORE the first Claude turn, so callers ask to
 * resume an id that has no transcript yet — Claude then exits with
 * "No conversation found with session ID: <id>". Gating the resume request on the
 * transcript actually existing keeps the first turn on `--session-id` (create) and lets
 * only later turns / reconnects use `--resume`. Self-healing: a deleted transcript also
 * correctly falls back to create. Mirrors {@link resolveTuiResume} for the tmux path.
 */
export function resolveResumeForPrint(
  requestedResume: boolean,
  sessionId: string,
  exists?: (p: string) => boolean,
  cwd: string = DATA_DIR,
): boolean {
  return resolveTuiResume(requestedResume, computeJsonlPath(cwd, sessionId), exists);
}

export function runClaude(userMessage: string, opts: RunClaudeOptions) {
  const effectiveSessionId = opts.sessionId || crypto.randomUUID();
  const needsResume = resolveResumeForPrint(!!opts.sessionId, effectiveSessionId);
  const session = getOrCreateSession(opts.channel, effectiveSessionId, { ...opts, needsResume });
  const promise = session.sendMessage(userMessage, {
    files: opts.files || [],
    callbackSource: opts.callbackSource ?? null,
    scheduleTaskId: opts.scheduleTaskId ?? null,
    isUserInitiated: opts.isUserInitiated ?? false,
    onProgress: opts.onProgress ?? null,
    onAssistantMessage: opts.onAssistantMessage ?? null,
    onToolUse: opts.onToolUse ?? null,
    onToolResult: opts.onToolResult ?? null,
  });
  return { promise, kill() { return session.kill(); }, sessionId: effectiveSessionId };
}

// --- DR-0012: TUI-mode session pool + dispatch helpers ---

/** Module-scoped TUI session pool, keyed by sessionKey (parallel to `sessions` for print mode). */
const tuiSessions = new Map<string, ClaudeTuiSession>();

/** Shared TmuxControl singleton — stateless, safe to reuse across all TUI sessions. */
const sharedTmux = new TmuxControl();

/** Pure dispatch: select claude adapter mode from an AgentSpawnConfig.
 *  Defaults to 'print' for missing or unrecognized values (conservative — never silently
 *  flips a session into the experimental TUI path). */
export function selectClaudeMode(config: AgentSpawnConfig): 'print' | 'tui' {
  return (config as any).claudeBackend === 'tui' ? 'tui' : 'print';
}

function getOrCreateTuiSession(config: AgentSpawnConfig, sessionIdEffective: string): ClaudeTuiSession {
  const key = config.sessionKey;
  const cwd = config.cwd || DATA_DIR;
  const composition = resolveMcpComposition(config.mcpComposition, config.cortexContext?.useCoreMcp);
  let session = tuiSessions.get(key);
  if (session && (
    session.sessionId !== sessionIdEffective
    || session.cwd !== cwd
    || session.mcpComposition !== composition
  )) {
    session.kill();
    session = undefined;
  }
  if (!session) {
    const channel = config.channel ?? config.env?.SLACK_CHANNEL ?? config.sessionKey;
    const opts = sessionOptionsFromSpawnConfig({ ...config, sessionId: sessionIdEffective });
    // `--resume` only works once a transcript exists. A fresh TUI session pre-registers its
    // sessionId before the first turn, so config.resume can be true with no transcript yet —
    // gate it on the jsonl actually existing, else the first turn fails "No conversation found".
    const needsResume = resolveTuiResume(config.resume, computeJsonlPath(cwd, sessionIdEffective));
    const sessionConfig: ClaudeTuiSessionConfig = {
      channel,
      sessionId: sessionIdEffective,
      sessionKey: key,
      cwd,
      needsResume,
      tools: opts.tools,
      systemPrompt: opts.systemPrompt,
      appendSystemPrompt: opts.appendSystemPrompt,
      model: opts.model,
      claudeAgent: opts.claudeAgent,
      pluginDirs: opts.pluginDirs,
      outputStyle: opts.outputStyle,
      extraOption: opts.extraOption ?? null,
      thinking: opts.thinking ?? null,
      mcpComposition: composition,
      callbackSource: opts.callbackSource,
      scheduleTaskId: opts.scheduleTaskId,
      anthropicBaseUrl: opts.anthropicBaseUrl,
      extraEnv: opts.extraEnv,
      context: opts.context,
      deps: { tmux: sharedTmux, tailFactory: defaultTailFactory },
    };
    session = new ClaudeTuiSession(sessionConfig);
    tuiSessions.set(key, session);
  }
  return session;
}

// --- ClaudeAdapter — DR-0008 §3.2 generic AgentAdapter entry point ---
//
// task f7cf scope:
//   - spawn() returns a real AgentProcess that drives one turn through the pooled ClaudeSession
//     via event-emitting callbacks (onAssistantMessage / onToolUse), then derives
//     ask_user_question / plan_written / rate_limit events from the resolved AgentResult
//     before pushing turn_complete and returning the AgentResult from send().
//   - AgentSpawnConfig.hooks (NormalizedHookSpec[]) is still NOT consumed; buildHooksSettings
//     uses the native tools string per DR-0008 §3.5 (Phase 3 work).
//   - AgentSpawnConfig.mcpServers is still NOT consumed; --mcp-config still references
//     agent-server/mcp-config.json per DR-0008 §3.6 (Phase 3 work).
//   - Claude-specific passthrough fields (channel / claudeAgent / callbackSource / scheduleTaskId /
//     isUserInitiated / rawTools / anthropicBaseUrl) are read directly from AgentSpawnConfig;
//     they're Phase-3 cleanup targets (see types.ts).

function canonicalToolsToNative(tools: string[] | undefined): string | null {
  if (!tools || tools.length === 0) return null;
  const native = tools
    .map(t => fromCanonical('claude', t))
    .filter((n): n is string => typeof n === 'string');
  return native.length ? native.join(',') : null;
}

function sessionOptionsFromSpawnConfig(config: AgentSpawnConfig): ClaudeSessionOptions & { sessionIdEffective: string } {
  const sessionIdEffective = config.sessionId || crypto.randomUUID();
  // rawTools (if set) overrides canonical→native translation so legacy callers that already pass Claude-native
  // "Bash,Read,..." strings via mode-manager do not need to be refactored in this task.
  const tools = config.rawTools ?? canonicalToolsToNative(config.tools);
  return {
    sessionIdEffective,
    needsResume: config.resume,
    model: config.model ?? null,
    sessionKey: config.sessionKey,
    systemPrompt: config.systemPrompt ?? null,
    appendSystemPrompt: config.appendSystemPrompt ?? null,
    outputStyle: config.outputStyle ?? null,
    tools,
    pluginDirs: config.pluginDirs ?? null,
    isUserInitiated: !!config.isUserInitiated,
    callbackSource: config.callbackSource ?? null,
    scheduleTaskId: config.scheduleTaskId ?? null,
    claudeAgent: config.claudeAgent ?? null,
    anthropicBaseUrl: config.anthropicBaseUrl,
    extraEnv: config.env,
    cwd: config.cwd ?? DATA_DIR,
    mcpComposition: resolveMcpComposition(config.mcpComposition, config.cortexContext?.useCoreMcp),
    mcpConfigPaths: config.mcpConfigPaths,
    disableHooks: config.disableHooks,
    streamDeltas: config.streamDeltas,
    captureTranscriptLogs: config.captureTranscriptLogs,
    preserveUnreportedAccounting: config.preserveUnreportedAccounting,
    processSpawner: config.processSpawner,
    cliPath: config.cliPath,
    benchmarkPolicyGuard: config.benchmarkPolicyGuard,
    pinnedEnv: config.pinnedEnv,
    extraOption: config.extraOption,
    thinking: config.thinking ?? null,
    context: config.cortexContext,
  };
}

/** Test hook: mirror of ClaudeSession.toSpawnOptions() for the AgentSpawnConfig entry point.
 *  Must stay in sync with ClaudeSession constructor + toSpawnOptions — both paths derive
 *  ClaudeSpawnOptions through deriveClaudeSpawnOptions(), so any field added to that helper
 *  is covered here without divergence. */
function computeSpawnArgsForConfig(config: AgentSpawnConfig): string[] {
  const opts = sessionOptionsFromSpawnConfig(config);
  const spawnOptions = deriveClaudeSpawnOptions({
    tools: opts.tools ?? null,
    systemPrompt: opts.systemPrompt ?? null,
    appendSystemPrompt: opts.appendSystemPrompt ?? null,
    model: opts.model ?? null,
    claudeAgent: opts.claudeAgent ?? null,
    pluginDirs: opts.pluginDirs ?? null,
    outputStyle: opts.outputStyle ?? null,
    extraOption: opts.extraOption,
    thinking: opts.thinking ?? null,
    needsResume: opts.needsResume,
    sessionId: opts.sessionIdEffective,
    mcpComposition: opts.mcpComposition ?? 'direct',
    mcpConfigPaths: opts.mcpConfigPaths,
    disableHooks: opts.disableHooks,
    benchmarkPolicyGuard: opts.benchmarkPolicyGuard,
    streamDeltas: opts.streamDeltas,
  });
  spawnOptions.isUserInitiated = config.isUserInitiated;
  return buildSpawnArgs(spawnOptions);
}

export class ClaudeAdapter implements AgentAdapter {
  readonly backend: Backend = 'claude';
  readonly capabilities: Set<Capability> = CAPABILITIES_BY_BACKEND.claude;

  spawn(config: AgentSpawnConfig): AgentProcess {
    // DR-0012: route to TUI implementation when profile selects it.
    if (selectClaudeMode(config) === 'tui') return this.spawnTui(config);
    const { sessionIdEffective, ...sessionOptions } = sessionOptionsFromSpawnConfig(config);
    // Gate resume on the transcript actually existing — a pre-registered sessionId
    // (e.g. cortex tui handshake) must spawn `--session-id` on its first turn, not
    // `--resume` (which fails "No conversation found"). See resolveResumeForPrint.
    sessionOptions.needsResume = resolveResumeForPrint(
      sessionOptions.needsResume,
      sessionIdEffective,
      undefined,
      sessionOptions.cwd,
    );
    const channel = config.channel ?? config.env?.SLACK_CHANNEL ?? config.sessionKey;
    const session = getOrCreateSession(channel, sessionIdEffective, sessionOptions);
    const stream = createEventStream<NormalizedEvent>();
    let started = false;

    return {
      sessionKey: config.sessionKey,
      get sessionId(): string | null { return session.sessionId; },
      get supervision(): AgentProcessSupervision | undefined { return session.getSupervision(); },
      async send(message: UserMessage): Promise<AgentResult> {
        if (!started) {
          stream.push({ type: 'session_started', sessionId: session.sessionId });
          started = true;
        }
        const files = (message.attachments || []).map((a) => ({
          mimetype: a.mimeType, localPath: a.path, name: path.basename(a.path),
        }));
        try {
          const result = await session.sendMessage(message.text, {
            files,
            onAssistantMessage: (text: string, blockId?: string, model?: string | null) =>
              stream.push({
                type: 'assistant_text', text,
                ...(blockId ? { blockId } : {}),
                ...(model != null ? { model } : {}),
              }),
            // Token-level preview of the block above. Same FIFO stream, so every delta is delivered
            // before the complete message that supersedes it.
            onAssistantDelta: (text: string, blockId: string) =>
              stream.push({ type: 'assistant_delta', text, blockId }),
            onToolUse: (name: string, input: any, toolUseId: string) =>
              stream.push({ type: 'tool_use', toolUseId, name, input }),
            onToolResult: (toolUseId: string, content: string, isError: boolean) =>
              stream.push({ type: 'tool_result', toolUseId, content, ok: !isError }),
            onCompact: (info: { trigger: string; preTokens?: number }) =>
              stream.push({ type: 'context_compacted', trigger: info.trigger, preTokens: info.preTokens }),
            onContextUsage: (usage: ContextUsage) =>
              stream.push({ type: 'context_usage', ...usage }),
            onProgress: (p: { num_turns?: number } | null) => {
              stream.push({ type: 'turn_progress', numTurns: p?.num_turns ?? 0 });
            },
          });
          // Derived events, in order, before the terminating turn_complete.
          for (const q of (result.askUserQuestions || [])) {
            stream.push({
              type: 'ask_user_question',
              toolUseId: q.toolUseId ?? '',
              questions: q.questions as any,
            });
          }
          if (result.planFilePath) {
            stream.push({
              type: 'plan_written',
              toolUseId: '',
              path: result.planFilePath,
              content: '',
            });
          }
          if (result.rateLimited) {
            stream.push({ type: 'rate_limit', raw: { message: result.rateLimitMessage } });
          }
          // Emit cost_record from the resolved turn, not mutable session accounting.
          const preserveReportedness = config.preserveUnreportedAccounting === true;
          const accounting = result.reportedAccounting;
          const hasReportableAccounting = preserveReportedness
            ? result.costReported === true || accounting?.usageReported === true
            : result.total_cost_usd != null || session.lastTokenUsage !== null;
          if (hasReportableAccounting) {
            const legacyUsage = session.lastTokenUsage;
            const exactPrompt = promptAccounting(legacyUsage);
            stream.push({
              type: 'cost_record',
              provider: 'anthropic',
              model: (preserveReportedness ? accounting?.model : session.lastModelName)
                || session.modelName || 'unknown',
              tokens_in: preserveReportedness
                ? accounting?.promptTokens ?? null : exactPrompt.promptTokens,
              tokens_out: preserveReportedness ? accounting?.outputTokens ?? null : legacyUsage?.output ?? 0,
              prompt_tokens: preserveReportedness
                ? accounting?.promptTokens ?? null : exactPrompt.promptTokens,
              cached_tokens: preserveReportedness
                ? accounting?.cachedTokens ?? null : exactPrompt.cachedTokens,
              cost_usd: preserveReportedness && result.costReported !== true
                ? null
                : result.total_cost_usd ?? null,
            });
          }
          stream.push({
            type: 'turn_complete',
            numTurns: preserveReportedness ? result.num_turns : result.num_turns ?? 0,
            totalCostUsd: result.total_cost_usd ?? null,
          });
          stream.close();
          return result;
        } catch (err: any) {
          if (!err?.cancelled) {
            stream.push({ type: 'error', message: String(err?.message ?? err), fatal: true });
          }
          stream.close();                         // unblock any for-await consumer
          throw err;
        }
      },
      events: stream.iterable,
      compact: (): Promise<AgentCompactResult> => session.compact(),
      setContinuationSink(sink: ContinuationSink): void { session.setContinuationSink(sink); },
      injectUserMessage(message: UserMessage): boolean { return session.injectUserMessage(message); },
      setInjectionAckSink(sink: InjectionAckSink): void { session.setInjectionAckSink(sink); },
      // Intentionally does NOT call session.close(): sessions are pooled per sessionKey and
      // reused across runAgentOnce turns. Pool-level cleanup goes through ClaudeAdapter.close(key)
      // or the legacy closeSession / closeSessionsByPrefix exports.
      async close(): Promise<void> { stream.close(); },
      kill(): boolean { return session.kill(); },
    };
  }

  /**
   * DR-0012 TUI-mode dispatch. Returns an AgentProcess whose send() pushes ALL NormalizedEvents
   * (including derived ones — ask_user_question, plan_*, cost_record, turn_complete) via
   * ClaudeTuiSession's onEvent stream, then resolves with the TuiAgentResult cast to AgentResult.
   *
   * Sessions are pooled in `tuiSessions` by sessionKey; multi-turn reuses the same tmux session.
   * kill() forwards to ClaudeTuiSession.kill() which tears down the tmux session.
   */
  private spawnTui(config: AgentSpawnConfig): AgentProcess {
    const sessionIdEffective = config.sessionId || crypto.randomUUID();
    const session = getOrCreateTuiSession(config, sessionIdEffective);
    const stream = createEventStream<NormalizedEvent>();
    let started = false;

    return {
      sessionKey: config.sessionKey,
      get sessionId(): string | null { return session.sessionId; },
      async send(message: UserMessage): Promise<AgentResult> {
        if (!started) {
          stream.push({ type: 'session_started', sessionId: session.sessionId });
          started = true;
        }
        const files = (message.attachments || []).map((a) => ({
          mimetype: a.mimeType, localPath: a.path, name: path.basename(a.path),
        }));
        try {
          const tuiResult = await session.sendMessage(message.text, {
            files,
            onEvent: (ev: NormalizedEvent) => stream.push(ev),
          });
          stream.close();
          // TuiAgentResult shape lines up with AgentResult — only structural cast needed.
          return tuiResult as unknown as AgentResult;
        } catch (err: any) {
          if (!err?.cancelled) {
            stream.push({ type: 'error', message: String(err?.message ?? err), fatal: true });
          }
          stream.close();
          throw err;
        }
      },
      events: stream.iterable,
      async close(): Promise<void> { stream.close(); },
      kill(): boolean { return session.kill(); },
    };
  }

  async close(sessionKey: string): Promise<void> {
    closeSession(sessionKey, sessionKey);
    // Also clean up any TUI session under this key (DR-0012).
    const tui = tuiSessions.get(sessionKey);
    if (tui) {
      tui.close();
      tuiSessions.delete(sessionKey);
    }
  }

  kill(sessionKey: string): boolean {
    const session = sessions.get(sessionKey);
    if (session) return session.kill();
    const tui = tuiSessions.get(sessionKey);
    if (tui) {
      const killed = tui.kill();
      tuiSessions.delete(sessionKey);
      return killed;
    }
    return false;
  }

  listSessions(): string[] {
    return [...sessions.keys(), ...tuiSessions.keys()];
  }
}

/**
 * DR-0012 §3.6 startup hook — sweep orphan tmux sessions matching the cortex-claude- prefix.
 *
 * Rationale: tmux sessions are independent of agent-server's process lifetime, but the in-memory
 * `tuiSessions` Map is not. After an agent-server restart we have no record of channel/sessionKey
 * → tmux mapping (it was never persisted), so we cannot re-adopt existing tmux sessions into the
 * pool. The honest choice is to kill them at startup; otherwise they accumulate forever and a
 * later session reusing the same sessionId would conflict with `tmux new-session -s <name>`
 * (which fails on duplicate). Logs the killed names so operators can investigate if needed.
 *
 * Full re-adoption (preserving an in-flight TUI session across restart) requires persisting
 * sessionKey + cwd + needsResume metadata to disk — deferred as a follow-up.
 *
 * Override `exec` in tests so we don't touch the real tmux server.
 */
export function recoverTuiOrphans(exec?: TmuxExec): { found: string[]; killed: string[] } {
  const tmux = exec ? new TmuxControl(exec) : sharedTmux;
  const found = tmux.listSessions(TUI_TMUX_NAME_PREFIX);
  if (found.length === 0) return { found: [], killed: [] };
  const killed: string[] = [];
  for (const name of found) {
    try {
      tmux.killSession(name);
      killed.push(name);
    } catch (e) {
      log.warn(`recoverTuiOrphans: failed to kill ${name}: ${(e as Error).message}`);
    }
  }
  log.info(`recoverTuiOrphans: swept ${killed.length}/${found.length} orphan tmux sessions (prefix=${TUI_TMUX_NAME_PREFIX})`);
  return { found, killed };
}

/** Construct a ClaudeSession WITHOUT spawning the `claude` child process, for unit
 *  testing handleLine / continuation routing. Initializes only the fields the line
 *  handlers touch. Callers should stub createTurnStreams to avoid log file I/O and
 *  register cleanup via t.after(() => session.close()) to clear the idle timer. */
function makeSessionForTest(
  modelName: string | null = null,
  autoCompactWindow: number | null = null,
): ClaudeSession {
  const s = Object.create(ClaudeSession.prototype) as any;
  s.sessionId = 'test-session';
  s.channel = 'test';
  s.sessionKey = 'test';
  s.bgTracker = new BgTaskTracker();
  s.streamDeltaState = createStreamDeltaState();
  s.contextUsageTracker = new ClaudeContextUsageTracker(modelName, autoCompactWindow);
  s.continuationSink = null;
  s.pendingContinuationDeliveries = [];
  s.pendingInjections = [];
  s.injectionAck = null;
  s.injectionContinuationArmed = false;
  s.currentTurn = null;
  s.idleTimer = null;
  s.turnIdleTimer = null;
  s.maxTimer = null;
  s.cumulativeCostUsd = 0;
  s.preserveUnreportedAccounting = false;
  s.lastTokenUsage = null;
  s.lastModelName = null;
  s.alive = true;
  s.proc = null;
  return s as ClaudeSession;
}

export const _test = {
  extractAskUserQuestions,
  mergeSubstantialOutput,
  computeSpawnArgs: computeSpawnArgsForConfig,
  makeSessionForTest,
};

// Re-exported for webhook consumer (parity with pre-refactor claude-bridge.ts:286 export)
export { getCurrentPlanFilePath };
export { CancelledError };
