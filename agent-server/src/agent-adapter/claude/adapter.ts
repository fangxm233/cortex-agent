import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface } from 'readline';
import * as crypto from 'crypto';
import { AGENT_CWD, resolveSpawnCwd } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { fromCanonical } from '@core/tool-names.js';
import { Capability, CAPABILITIES_BY_BACKEND } from '../capabilities.js';
import { resolveMcpComposition } from '../types.js';
import type {
  AgentCompactResult, AgentProcessSpawner,
  AgentProcessSupervision, EngineAdapter, EngineSpec, Backend, BackgroundTurnSink,
  InjectionAckSink, McpComposition, RateLimitObservation, RateLimitOrigin, RateLimitReporter,
  SpawnedAgentProcess, UserMessage,
} from '../types.js';
import { ClaudeEngineSession, type ClaudeEngineOpenHooks } from './engine.js';
import { encodeMcpBundles, MCP_BUNDLES_ENV } from '@core/mcp-bundles.js';
import {
  CancelledError,
  IDLE_SESSION_TIMEOUT,
  TURN_IDLE_TIMEOUT,
} from './defaults.js';
import {
  buildClaudeEnv, buildSpawnArgs, claudeRouteIdentity, resolveClaudeMcpBundles,
  ClaudeSpawnOptions, CortexAgentContext,
} from './spawn-args.js';
import { computeTranscriptPath, resolveResumeAgainstTranscript } from './transcript-path.js';
import { TmuxControl, type TmuxExec } from './tmux-control.js';
import { TUI_TMUX_NAME_PREFIX } from './defaults.js';
import {
  buildPrompt,
  clearActivePlanFile,
  extractAskUserQuestions,
  getCurrentPlanFilePath,
  mergeSubstantialOutput,
  createStreamDeltaState,
} from './event-parser.js';
import { BgTaskTracker } from './bg-task-tracker.js';
import { ClaudeTurnMachine, type PendingTurn, type TurnHost } from './turn-machine.js';
import {
  type ClaudeTurnCallbacks,
  type TurnTokenUsage,
} from './event-translator.js';
import { ClaudeContextUsageTracker } from './context-usage.js';
import { resolveAutoCompactWindow } from './compact-window.js';
import {
  validateClaudeSupplementalMcpConfig,
  writeClaudeSupplementalMcpConfig,
} from './mcp-config.js';
import { writeBrowserMcpConfig } from './browser-mcp.js';

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

interface ClaudeSessionOptions {
  needsResume: boolean;
  model?: string | null;
  isUserInitiated?: boolean;
  /** Expose the commission-creation tools; set only while a contract is being drafted. */
  commissionTools?: boolean;
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
  /** Keys deleted from the child env after `extraEnv` is applied (EngineSpec.env.unsets). */
  unsetEnv?: string[];
  cwd?: string;
  mcpComposition?: McpComposition;
  mcpConfigPaths?: string[];
  mcpToolAllowlist?: string[];
  supplementalMcpConfigPath?: string | null;
  supplementalMcpConfigIdentity?: string | null;
  /** Playwright MCP config for a browser-enabled session. Kept separate from the supplemental
   *  (plugin) config because a session can legitimately have both. */
  browserMcpConfigPath?: string | null;
  browserMcpConfigIdentity?: string | null;
  pluginCapabilityFingerprint?: string | null;
  disableHooks?: boolean;
  streamDeltas?: boolean;
  captureTranscriptLogs?: boolean;
  preserveUnreportedAccounting?: boolean;
  processSpawner?: AgentProcessSpawner;
  /** Optional absolute Claude CLI path. */
  cliPath?: string;
  /** Exact allowlisted child environment for an isolated process. */
  pinnedEnv?: NodeJS.ProcessEnv;
  /** Extra CLI options from profile (e.g. {"--thinking": "xhigh"}). */
  extraOption?: Record<string, string>;
  /** Thinking level from the profile's `thinking` field → `--effort <level>`. Absent → no flag. */
  thinking?: string | null;
  /** Cortex execution context surfaced to the MCP server child as CORTEX_THREAD_ID/PROFILE/PROJECT/SESSION_NAME env vars.
   *  Captured at spawn time; later turns on the same session reuse the original snapshot. */
  context?: CortexAgentContext;
  /** Pool hooks: the owner's eviction callbacks. See `ClaudeEngineOpenHooks`. */
  onSelfClose?: ClaudeEngineOpenHooks['onSelfClose'];
  onEvict?: ClaudeEngineOpenHooks['onEvict'];
  /** Host throttle entry point. Absent ⇒ observations are dropped; see `ClaudeAdapterHooks`. */
  onRateLimit?: RateLimitReporter;
}

interface ClaudeSpawnFields extends ClaudeSpawnOptions {
  mcpComposition: McpComposition;
  extraOption: Record<string, string> | undefined;
  thinking: string | null;
}

/** Single source of truth for ClaudeSession fields → ClaudeSpawnOptions CLI args translation.
 *  Used by both ClaudeSession.toSpawnOptions() (production) and _test.computeSpawnArgs (lock-in test). */
function deriveClaudeSpawnOptions(fields: ClaudeSpawnFields): ClaudeSpawnOptions {
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
    mcpToolAllowlist: fields.mcpToolAllowlist,
    supplementalMcpConfigPath: fields.supplementalMcpConfigPath,
    browserMcpConfigPath: fields.browserMcpConfigPath,
    disableHooks: fields.disableHooks,
    streamDeltas: fields.streamDeltas,
  };
}

export interface ClaudeSpawnCompatibility {
  cwd: string;
  /** Endpoint plus credential digests. A mode switch changes it, and a live process cannot be
   *  re-pointed once spawned, so a difference must force a fresh one. */
  routeIdentity: string;
  composition: McpComposition;
  interactionBridge: boolean;
  /** Adding the commission tools rewrites `--tools`, which a live process cannot be re-pointed
   *  at, so a change must force a fresh spawn + `--resume`. */
  commissionTools: boolean;
  tools: string | null;
  pluginCapabilityFingerprint: string | null;
  pluginDirs: string[];
  mcpConfigPaths: string[];
  mcpToolAllowlist: string[] | null;
  supplementalMcpConfigIdentity: string | null;
  /** Turning the browser on or off must force a FRESH process: a pooled Claude keeps whatever MCP
   *  set it was spawned with, so without this the toggle would silently no-op until the process died. */
  browserMcpConfigIdentity: string | null;
}

function cloneTextArray(values: string[] | null | undefined): string[] {
  return values ? [...values] : [];
}

function sameTextArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function optionalTextArray(values: string[] | null | undefined): string[] | null {
  return values === undefined || values === null ? null : [...values];
}

function sameOptionalTextArray(
  left: readonly string[] | null, right: readonly string[] | null,
): boolean {
  if (left === null || right === null) return left === right;
  return sameTextArray(left, right);
}

export function sameClaudeSpawnCompatibility(
  left: ClaudeSpawnCompatibility,
  right: ClaudeSpawnCompatibility,
): boolean {
  return left.cwd === right.cwd
    && left.routeIdentity === right.routeIdentity
    && left.composition === right.composition
    && left.interactionBridge === right.interactionBridge
    && left.commissionTools === right.commissionTools
    && left.tools === right.tools
    && left.pluginCapabilityFingerprint === right.pluginCapabilityFingerprint
    && left.supplementalMcpConfigIdentity === right.supplementalMcpConfigIdentity
    && left.browserMcpConfigIdentity === right.browserMcpConfigIdentity
    && sameTextArray(left.pluginDirs, right.pluginDirs)
    && sameTextArray(left.mcpConfigPaths, right.mcpConfigPaths)
    && sameOptionalTextArray(left.mcpToolAllowlist, right.mcpToolAllowlist);
}

function compatibilityFromOptions(options: ClaudeSessionOptions): ClaudeSpawnCompatibility {
  const composition = resolveMcpComposition(options.mcpComposition, options.context?.useCoreMcp);
  return {
    cwd: resolveSpawnCwd(options.cwd),
    routeIdentity: claudeRouteIdentity(options),
    composition,
    interactionBridge: composition === 'direct' && options.isUserInitiated === true,
    commissionTools: options.commissionTools === true,
    tools: options.tools ?? null,
    pluginCapabilityFingerprint: options.pluginCapabilityFingerprint ?? null,
    pluginDirs: cloneTextArray(options.pluginDirs),
    mcpConfigPaths: cloneTextArray(options.mcpConfigPaths),
    mcpToolAllowlist: optionalTextArray(options.mcpToolAllowlist),
    supplementalMcpConfigIdentity: options.supplementalMcpConfigIdentity ?? null,
    browserMcpConfigIdentity: options.browserMcpConfigIdentity ?? null,
  };
}

/**
 * A string whose equality is exactly {@link sameClaudeSpawnCompatibility}'s predicate — the pool key
 * `EngineSession.identity` needs. Serialized as an explicit, literal field list rather than
 * `Object.keys`, so the order is stable and a future field cannot silently change the encoding.
 *
 * `null` and `[]` stay distinct for `mcpToolAllowlist` (sameOptionalTextArray is identity-sensitive
 * when either side is null) and arrays keep their order (sameTextArray is order-sensitive).
 */
export function claudeCompatibilityIdentity(compatibility: ClaudeSpawnCompatibility): string {
  const fields: Array<[string, unknown]> = [
    ['cwd', compatibility.cwd],
    ['routeIdentity', compatibility.routeIdentity],
    ['composition', compatibility.composition],
    ['interactionBridge', compatibility.interactionBridge],
    ['commissionTools', compatibility.commissionTools],
    ['tools', compatibility.tools],
    ['pluginCapabilityFingerprint', compatibility.pluginCapabilityFingerprint],
    ['supplementalMcpConfigIdentity', compatibility.supplementalMcpConfigIdentity],
    ['browserMcpConfigIdentity', compatibility.browserMcpConfigIdentity],
    ['pluginDirs', compatibility.pluginDirs],
    ['mcpConfigPaths', compatibility.mcpConfigPaths],
    ['mcpToolAllowlist', compatibility.mcpToolAllowlist],
  ];
  return JSON.stringify(fields);
}

/** The resolved-spec identity: the compatibility record the pool would compare, serialized. */
export function claudeSpecIdentity(spec: EngineSpec): string {
  return claudeCompatibilityIdentity(compatibilityFromOptions(sessionOptionsFromSpec(spec)));
}

/** Resolve per-session settings from the spawn cwd without falling through a pinned trial's config. */
function createContextUsageTracker(
  modelName: string | null,
  cwd: string,
  options: ClaudeSessionOptions,
): ClaudeContextUsageTracker {
  return new ClaudeContextUsageTracker(
    modelName,
    resolveAutoCompactWindow(cwd, options.pinnedEnv?.CLAUDE_CONFIG_DIR),
  );
}

class ClaudeSession implements TurnHost {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  sessionId: string;
  channel: string;
  private sessionKey: string;
  /** Model name requested via --model CLI arg (used as fallback for cost_record). */
  modelName: string | null;
  private isUserInitiated: boolean;
  private commissionTools: boolean;
  private callbackSource: string | null;
  private scheduleTaskId: string | null;
  private claudeAgent: string | null;
  private systemPrompt: string | null;
  private appendSystemPrompt: string | null;
  private outputStyle: string | null;
  private tools: string | null;
  private pluginDirs: string[] | null;
  anthropicBaseUrl: string | undefined;
  private extraEnv: Record<string, string> | undefined;
  private unsetEnv: string[] | undefined;
  private cwd: string;
  private mcpComposition: McpComposition;
  private mcpConfigPaths: string[] | undefined;
  private mcpToolAllowlist: string[] | undefined;
  private supplementalMcpConfigPath: string | null;
  private browserMcpConfigPath: string | null;
  private compatibility: ClaudeSpawnCompatibility;
  private disableHooks: boolean;
  private streamDeltas: boolean | undefined;
  captureTranscriptLogs!: boolean;
  preserveUnreportedAccounting!: boolean;
  private processSpawner!: AgentProcessSpawner | undefined;
  private cliPath!: string | undefined;
  private pinnedEnv!: NodeJS.ProcessEnv | undefined;
  private supervision: AgentProcessSupervision | undefined;
  private extraOption!: Record<string, string> | undefined;
  private thinking!: string | null;
  private context!: CortexAgentContext | undefined;
  /** Pool eviction hooks supplied by the owner: `onSelfClose` preserves the
   *  "only if this key still points at me" guard at the pool; `onEvict` is unconditional, matching
   *  the fatal stdin-write path it replaced. */
  private readonly onSelfClose: ClaudeEngineOpenHooks['onSelfClose'];
  private readonly onEvict: ClaudeEngineOpenHooks['onEvict'];
  /** Injected throttle sink. Unset in a trial, wired to `handleRateLimitEvent` by
   *  `domain/runs/adapters.ts` in the daemon. */
  private readonly onRateLimit: RateLimitReporter | undefined;
  /** The turn half. Built before the process is spawned, so the first line has a home. */
  private readonly turns: ClaudeTurnMachine;
  private alive: boolean = false;
  private needsResume: boolean;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private turnIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private stderr: string = '';

  constructor(channel: string, sessionId: string, options: ClaudeSessionOptions) {
    this.channel = channel;
    this.sessionId = sessionId;
    this.sessionKey = options.sessionKey || channel;
    this.onRateLimit = options.onRateLimit;
    this.needsResume = options.needsResume;
    this.modelName = options.model || null;
    this.cwd = resolveSpawnCwd(options.cwd);
    this.turns = new ClaudeTurnMachine(this, createContextUsageTracker(this.modelName, this.cwd, options));
    this.isUserInitiated = options.isUserInitiated || false;
    this.commissionTools = options.commissionTools === true;
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
    this.unsetEnv = options.unsetEnv;
    this.mcpComposition = resolveMcpComposition(options.mcpComposition, options.context?.useCoreMcp);
    this.mcpConfigPaths = options.mcpConfigPaths;
    this.mcpToolAllowlist = options.mcpToolAllowlist;
    this.supplementalMcpConfigPath = options.supplementalMcpConfigPath ?? null;
    this.browserMcpConfigPath = options.browserMcpConfigPath ?? null;
    this.compatibility = compatibilityFromOptions(options);
    this.disableHooks = options.disableHooks === true;
    this.streamDeltas = options.streamDeltas;
    this.onSelfClose = options.onSelfClose;
    this.onEvict = options.onEvict;
    this.initializeExecutionOptions(options);
    this.spawnProcess();
  }

  private initializeExecutionOptions(options: ClaudeSessionOptions): void {
    this.captureTranscriptLogs = options.captureTranscriptLogs !== false;
    this.preserveUnreportedAccounting = options.preserveUnreportedAccounting === true;
    this.processSpawner = options.processSpawner;
    this.cliPath = options.cliPath;
    this.pinnedEnv = options.pinnedEnv;
    this.extraOption = options.extraOption;
    this.thinking = options.thinking ?? null;
    this.context = options.context;
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
      mcpToolAllowlist: this.mcpToolAllowlist,
      supplementalMcpConfigPath: this.supplementalMcpConfigPath,
      browserMcpConfigPath: this.browserMcpConfigPath,
      disableHooks: this.disableHooks,
      streamDeltas: this.streamDeltas,
    });
  }

  matchesSpawn(next: ClaudeSpawnCompatibility): boolean {
    return sameClaudeSpawnCompatibility(this.compatibility, next);
  }

  private handleProcessClose(code: number | null): void {
    log.info(`Process closed: ${this.sessionId.substring(0, 8)} code=${code}`);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
    this.idleTimer = null;
    this.turnIdleTimer = null;
    this.alive = false;
    clearActivePlanFile(this.sessionId);
    this.turns.abortTurnOnProcessClose(code, this.stderr);
    // Waiting-window case (no active turn, background tasks pending): the held status would
    // otherwise wait forever — any process death (restart / crash / kill / timeout) must
    // seal it. No-op when nothing is pending; always releases the sink (session is gone).
    this.turns.notifyBgInterrupted();
    this.onSelfClose?.(this.sessionKey, this);
  }

  private validateSupplementalMcpConfig(): void {
    const configPath = this.supplementalMcpConfigPath;
    const identity = this.compatibility.supplementalMcpConfigIdentity;
    if (!configPath || !identity) return;
    validateClaudeSupplementalMcpConfig(configPath, identity);
  }

  private buildProcessLaunch(): { args: string[]; env: NodeJS.ProcessEnv } {
    const options = this.toSpawnOptions();
    options.loadSlackMcp = this.channel.startsWith('slack:');
    options.loadFeishuMcp = this.channel.startsWith('feishu:');
    options.loadWebMcp = this.channel.startsWith('web:');
    options.isUserInitiated = this.isUserInitiated;
    options.commissionTools = this.commissionTools;
    const env = buildClaudeEnv(
      this.channel, this.sessionId, this.callbackSource, this.scheduleTaskId,
      this.anthropicBaseUrl, this.extraEnv, this.context, this.pinnedEnv, this.unsetEnv,
    );
    env[MCP_BUNDLES_ENV] = encodeMcpBundles(resolveClaudeMcpBundles(options));
    return { args: buildSpawnArgs(options), env };
  }

  private attachSpawnedProcess(spawned: SpawnedAgentProcess): void {
    this.proc = spawned.process;
    this.supervision = spawned.supervision;
    this.stderr = '';
    this.rl = createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.turns.handleLine(line));
    this.proc.stderr!.on('data', (data) => { this.stderr += data.toString(); });
    this.proc.on('close', (code) => this.handleProcessClose(code));
  }

  private armProcessTimers(): void {
    this.alive = true;
    this.resetIdleTimer();
  }

  private spawnProcess(): void {
    this.validateSupplementalMcpConfig();
    const { args, env } = this.buildProcessLaunch();
    log.info(`Spawning persistent process: ${this.sessionId.substring(0, 8)} ${this.needsResume ? '(resume)' : '(new)'}`);
    const spawned = spawnClaudeProcess(
      this.processSpawner, args, { cwd: this.cwd, env }, this.cliPath,
    );
    this.attachSpawnedProcess(spawned);
    this.armProcessTimers();
  }

  writeTurnStdin(prompt: string): void {
    const stdinMsg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: prompt },
      session_id: this.sessionId,
    }) + '\n';
    try {
      this.proc!.stdin!.write(stdinMsg);
    } catch (e: any) {
      this.alive = false;
      this.turns.failInFlightTurn(new Error(`Failed to write to claude stdin: ${e.message}`));
      this.onEvict?.(this.sessionKey, this);
      throw new Error(`Claude process stdin write failed: ${e.message}`);
    }
  }

  private startTurnIdleTimer(): void {
    this.turnIdleTimer = setTimeout(() => {
      log.info(`Session ${this.sessionId.substring(0, 8)} turn idle for 60min, killing`);
      this.kill();
    }, TURN_IDLE_TIMEOUT);
  }

  async sendMessage(userMessage: string, options: ClaudeTurnCallbacks): Promise<any> {
    if (!this.alive) {
      this.needsResume = true;
      this.spawnProcess();
    }
    this.resetIdleTimer();
    const prompt = buildPrompt(userMessage, options.attachments ?? []);
    const streams = this.turns.createTurnStreams(userMessage);

    const turnPromise = new Promise<any>((resolve, reject) => {
      this.turns.registerTurn(resolve, reject, streams, options);
    });

    this.writeTurnStdin(prompt);
    this.startTurnIdleTimer();

    const result = await turnPromise;
    this.clearTurnIdleTimer();
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
      contextUsage: null, usage: this.turns.compactUsage(result),
    };
  }

  bumpTurnIdleTimer(): void {
    if (!this.turnIdleTimer) return;
    clearTimeout(this.turnIdleTimer);
    this.startTurnIdleTimer();
  }

  resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // While background tasks are still running — or an injected message is queued inside the CLI
    // awaiting its spontaneous turn — the session must stay alive to receive the continuation,
    // even through a long silent wait. Don't arm idle-close; the session lives until the
    // background work settles or it is closed/killed explicitly.
    if (this.turns.holdsIdle()) {
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
    if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
    // Do NOT clear backgroundTurnSink here: if background tasks are pending, the process
    // 'close' event (handleProcessClose) must still deliver the interruption to the sink
    // so the held "background task running" status seals instead of waiting forever.
    if (!this.proc || !this.alive) {
      // Process already gone (or never spawned): no 'close' event will come — seal now.
      this.turns.notifyBgInterrupted();
      return;
    }
    this.alive = false;

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
    if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
    // Sink intentionally NOT cleared: handleProcessClose (via the SIGTERM 'close' event)
    // delivers the background-task interruption to it, then clears it.
    if (!this.proc || this.proc.exitCode !== null) return false;
    this.alive = false;
    this.turns.markCurrentTurnKilled();
    if (this.supervision) {
      this.supervision.cancel('cancel');
      return true;
    }
    try { this.proc.kill('SIGTERM'); return true; } catch { return false; }
  }

  // --- TurnHost port ---

  /** The live-stdin precondition `injectUserMessage` checks before writing. */
  canWriteStdin(): boolean {
    return this.alive && !!this.proc?.stdin;
  }

  clearTurnIdleTimer(): void {
    if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
    this.turnIdleTimer = null;
  }

  /** Forward a provider rate-limit window to the host's throttle. With no sink injected the
   *  observation is dropped — the adapter has no opinion about quota policy (D10). */
  reportRateLimit(info: RateLimitObservation, origin: RateLimitOrigin): Promise<void> {
    return this.onRateLimit ? this.onRateLimit(info, origin) : Promise.resolve();
  }

  // --- Turn delegation. Thin by design: `ClaudeAdapter.spawn` and the unit tests still reach the
  //     turn through the session. ---

  handleLine(line: string): void { this.turns.handleLine(line); }

  createTurnStreams(userMessage: string) { return this.turns.createTurnStreams(userMessage); }

  get currentTurn(): PendingTurn | null { return this.turns.currentTurn; }
  set currentTurn(turn: PendingTurn | null) { this.turns.currentTurn = turn; }

  get backgroundTurnSink(): BackgroundTurnSink | null { return this.turns.backgroundTurnSink; }
  set backgroundTurnSink(sink: BackgroundTurnSink | null) { this.turns.backgroundTurnSink = sink; }

  get bgTracker(): BgTaskTracker { return this.turns.bgTracker; }

  /** Read by `pushDerivedTurnEvents` as the turn's accountingSource. */
  get lastModelName(): string | null { return this.turns.lastModelName; }

  get lastTokenUsage(): TurnTokenUsage | null { return this.turns.lastTokenUsage; }

  setBackgroundTurnSink(sink: BackgroundTurnSink): void { this.turns.setBackgroundTurnSink(sink); }

  clearBackgroundTurnSink(): void { this.turns.clearBackgroundTurnSink(); }

  setInjectionAckSink(sink: InjectionAckSink): void { this.turns.setInjectionAckSink(sink); }

  clearInjectionAckSink(): void { this.turns.clearInjectionAckSink(); }

  injectUserMessage(message: UserMessage): boolean { return this.turns.injectUserMessage(message); }

  getSupervision(): AgentProcessSupervision | undefined {
    return this.supervision;
  }

  isAlive(): boolean {
    return this.alive;
  }
}

/**
 * Decide whether a print-mode ClaudeSession should spawn with `--resume <id>`.
 *
 * Print sessions default to `AGENT_CWD` and may receive an explicit cwd, so transcript lookup uses
 * the same resolved cwd as the process spawn. A *fresh* session (notably the `cortex tui`
 * frontend) pre-registers its sessionId BEFORE the first Claude turn, so callers ask to
 * resume an id that has no transcript yet — Claude then exits with
 * "No conversation found with session ID: <id>". Gating the resume request on the
 * transcript actually existing keeps the first turn on `--session-id` (create) and lets
 * only later turns / reconnects use `--resume`. Self-healing: a deleted transcript also
 * correctly falls back to create. The decision itself lives in
 * {@link resolveResumeAgainstTranscript} so any print-mode caller shares one rule.
 */
export function resolveResumeForPrint(
  requestedResume: boolean,
  sessionId: string,
  exists?: (p: string) => boolean,
  cwd: string = AGENT_CWD,
): boolean {
  return resolveResumeAgainstTranscript(requestedResume, computeTranscriptPath(cwd, sessionId), exists);
}

// --- EngineSpec → ClaudeSession options ---
//
// The helpers below translate one EngineSpec into the fields a ClaudeSession needs:
//   - EngineSpec.mcp.servers is projected into a private supplemental --mcp-config file;
//     the base agent-server/mcp-config.json remains first in the composition.
//   - EngineSpec carries no hook list; the `--settings` hooks are compiled from the resolved
//     native tools string in spawn-args.ts (buildHooksSettings).
//   - Claude-private fields (context.channel / backend.claudeAgent / context.callbackSource /
//     context.scheduleTaskId / flags.isUserInitiated / tools.rawClaude / route.anthropicBaseUrl)
//     are read directly off EngineSpec rather than modelled as backend-neutral fields.

function canonicalToolsToNative(tools: string[] | undefined): string | null {
  if (!tools || tools.length === 0) return null;
  const native = tools
    .map(t => fromCanonical('claude', t))
    .filter((n): n is string => typeof n === 'string');
  return native.length ? native.join(',') : null;
}

function supplementalMcpConfig(
  spec: EngineSpec,
  composition: McpComposition,
): ReturnType<typeof writeClaudeSupplementalMcpConfig> | null {
  if (!spec.mcp.servers) return null;
  if (composition !== 'direct' && composition !== 'thread-control') return null;
  return writeClaudeSupplementalMcpConfig(spec.mcp.servers);
}

function sessionPresentationOptions(spec: EngineSpec): Partial<ClaudeSessionOptions> {
  const claudeBackend = spec.backend.kind === 'claude' ? spec.backend : undefined;
  return {
    model: spec.model.id ?? null,
    systemPrompt: spec.prompt.system ?? null,
    appendSystemPrompt: spec.prompt.append ?? null,
    outputStyle: claudeBackend?.outputStyle ?? null,
    tools: spec.tools.rawClaude ?? canonicalToolsToNative(spec.tools.canonical),
    pluginDirs: spec.plugins.dirs ?? null,
    isUserInitiated: !!spec.flags.isUserInitiated,
    callbackSource: spec.context.callbackSource ?? null,
    scheduleTaskId: spec.context.scheduleTaskId ?? null,
    claudeAgent: claudeBackend?.claudeAgent ?? null,
    thinking: spec.model.thinking ?? null,
  };
}

function sessionRuntimeOptions(
  spec: EngineSpec,
  composition: McpComposition,
): Partial<ClaudeSessionOptions> {
  const supplemental = supplementalMcpConfig(spec, composition);
  // Only a direct session can carry browser tools — thread/dispatch workers run unattended, where a
  // shared browser would be a cross-run side channel rather than a feature.
  const browser = spec.mcp.browserCdpEndpoint && composition === 'direct'
    ? writeBrowserMcpConfig(spec.mcp.browserCdpEndpoint)
    : null;
  return {
    anthropicBaseUrl: spec.route.anthropicBaseUrl,
    extraEnv: spec.env.sets,
    unsetEnv: spec.env.unsets,
    cwd: resolveSpawnCwd(spec.cwd),
    mcpComposition: composition,
    mcpConfigPaths: spec.mcp.configPaths,
    mcpToolAllowlist: spec.mcp.allowlist,
    commissionTools: spec.mcp.commissionTools === true,
    supplementalMcpConfigPath: supplemental?.path ?? null,
    supplementalMcpConfigIdentity: supplemental?.identity ?? null,
    browserMcpConfigPath: browser?.path ?? null,
    browserMcpConfigIdentity: browser?.identity ?? null,
    pluginCapabilityFingerprint: spec.plugins.fingerprint ?? null,
    disableHooks: spec.flags.disableHooks,
    streamDeltas: spec.flags.streamDeltas,
    captureTranscriptLogs: spec.flags.captureTranscripts,
    preserveUnreportedAccounting: spec.flags.preserveUnreportedAccounting,
    processSpawner: spec.process.spawner,
    cliPath: spec.process.cliPath,
    pinnedEnv: spec.env.pinned,
    extraOption: spec.extraOption,
    context: spec.env.context,
  };
}

function sessionOptionsFromSpec(
  spec: EngineSpec,
): ClaudeSessionOptions & { sessionIdEffective: string } {
  const composition = resolveMcpComposition(spec.mcp.composition, spec.env.context?.useCoreMcp);
  return {
    sessionIdEffective: spec.resume.backendSessionId || crypto.randomUUID(),
    needsResume: spec.resume.resume,
    sessionKey: spec.engineKey,
    ...sessionPresentationOptions(spec),
    ...sessionRuntimeOptions(spec, composition),
  };
}

/** Test hook: mirror of ClaudeSession.toSpawnOptions() for the EngineSpec entry point.
 *  Must stay in sync with ClaudeSession constructor + toSpawnOptions — both paths derive
 *  ClaudeSpawnOptions through deriveClaudeSpawnOptions(), so any field added to that helper
 *  is covered here without divergence. */
function computeSpawnArgsForSpec(spec: EngineSpec): string[] {
  const opts = sessionOptionsFromSpec(spec);
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
    mcpToolAllowlist: opts.mcpToolAllowlist,
    supplementalMcpConfigPath: opts.supplementalMcpConfigPath,
    browserMcpConfigPath: opts.browserMcpConfigPath,
    disableHooks: opts.disableHooks,
    streamDeltas: opts.streamDeltas,
  });
  spawnOptions.isUserInitiated = spec.flags.isUserInitiated;
  spawnOptions.commissionTools = spec.mcp.commissionTools === true;
  return buildSpawnArgs(spawnOptions);
}

/** D9: `claudeBackend: 'tui'` is accepted but deprecated; warn once per process, then run print. */
let warnedTuiDeprecated = false;

/** Collaborators the daemon owns and a trial replaces — the Claude twin of `PIAdapterHooks`.
 *  Left unset, a rate-limit window the CLI reports is observed and discarded; the daemon wires the
 *  real throttle in `domain/runs/adapters.ts`. */
export interface ClaudeAdapterHooks {
  /** Where `rate_limit_event` lines go. Injected because the throttle is domain state (D10). */
  onRateLimit?: RateLimitReporter;
}

export class ClaudeAdapter implements EngineAdapter {
  readonly backend: Backend = 'claude';
  readonly capabilities: Set<Capability> = CAPABILITIES_BY_BACKEND.claude;
  private readonly onRateLimit: RateLimitReporter | undefined;

  constructor(hooks: ClaudeAdapterHooks = {}) {
    this.onRateLimit = hooks.onRateLimit;
  }

  /**
   * Pure construction (plan §3.3): resolve the spec exactly as the old `spawn()` did, build a
   * fresh `ClaudeSession` and wrap it in an engine. No pool read, no pool write, no
   * `getOrCreate*`. The owner (`SessionEngines`) supplies the eviction hooks.
   *
   * "Pure" is about the POOL, not about side effects: `new ClaudeSession(...)` spawns the CLI
   * child in its constructor, as it always has. Every `open()` therefore costs a process — call it
   * only when you have decided to create, the way `acquire` does.
   */
  open(spec: EngineSpec, hooks: ClaudeEngineOpenHooks = {}): ClaudeEngineSession {
    // D9: TUI is deprecated — one warning, then continue down the print path (never a throw).
    if (spec.backend.kind === 'claude' && spec.backend.claudeBackend === 'tui' && !warnedTuiDeprecated) {
      warnedTuiDeprecated = true;
      log.warn('claudeBackend "tui" is deprecated (D9); running this session in print mode');
    }
    const { sessionIdEffective, ...sessionOptions } = sessionOptionsFromSpec(spec);
    // Same resume gate as the old spawn(): a pre-registered sessionId with no transcript yet must create.
    sessionOptions.needsResume = resolveResumeForPrint(
      sessionOptions.needsResume,
      sessionIdEffective,
      undefined,
      sessionOptions.cwd,
    );
    const channel = spec.context.channel ?? spec.env.sets?.SLACK_CHANNEL ?? spec.engineKey;
    // The old pooled lookup keyed the session on `options.sessionKey || channel`; preserve that.
    const key = sessionOptions.sessionKey || channel;
    const session = new ClaudeSession(channel, sessionIdEffective, {
      ...sessionOptions,
      sessionKey: key,
      onSelfClose: hooks.onSelfClose,
      onEvict: hooks.onEvict,
      onRateLimit: this.onRateLimit,
    });
    return new ClaudeEngineSession(session, spec, claudeSpecIdentity(spec));
  }

  /** The comparable identity of the session this spec *would* open — the pool's reuse test. */
  specIdentity(spec: EngineSpec): string {
    return claudeSpecIdentity(spec);
  }

  /** The resume decision `open()` will make for a spec, plus the transcript id it would target.
   *  The pool's fourth reuse clause compares this against a live session's `sessionId`: asked to
   *  resume transcript X while the pooled session sits on transcript Y ⇒ a fresh process. */
  claudeResumeTarget(spec: EngineSpec): { needsResume: boolean; sessionId: string } {
    const { sessionIdEffective, ...sessionOptions } = sessionOptionsFromSpec(spec);
    return {
      needsResume: resolveResumeForPrint(
        sessionOptions.needsResume,
        sessionIdEffective,
        undefined,
        sessionOptions.cwd,
      ),
      sessionId: sessionIdEffective,
    };
  }
}

/**
 * Startup hook — sweep orphan tmux sessions matching the `cortex-claude-` prefix.
 *
 * This is a one-way MIGRATION SWEEP, not support for a live TUI mode: D9 retired
 * `claudeBackend: 'tui'` and no new TUI tmux session can be created. It exists because tmux
 * sessions outlive agent-server's process, so machines upgrading across the D9 boundary still
 * hold `cortex-claude-<sessionId>` sessions from older builds. The in-memory bookkeeping that
 * could re-adopt them (the TUI session map) is gone, so the honest move is to
 * kill the leftovers at startup — otherwise they accumulate forever and a later session reusing
 * the same sessionId would collide with `tmux new-session -s <name>` (which fails on duplicates).
 *
 * Deletable once the deprecation window closes and no pre-D9 build can still be upgraded from.
 * Logs the killed names so operators can investigate if needed.
 *
 * Override `exec` in tests so we don't touch the real tmux server.
 */
export function recoverTuiOrphans(exec?: TmuxExec): { found: string[]; killed: string[] } {
  const tmux = exec ? new TmuxControl(exec) : new TmuxControl();
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
  const turns = Object.create(ClaudeTurnMachine.prototype) as any;
  turns.host = s;
  s.turns = turns;
  s.sessionId = 'test-session';
  s.channel = 'test';
  s.sessionKey = 'test';
  turns.bgTracker = new BgTaskTracker();
  turns.streamDeltaState = createStreamDeltaState();
  turns.contextUsageTracker = new ClaudeContextUsageTracker(modelName, autoCompactWindow);
  turns.backgroundTurnSink = null;
  turns.pendingContinuationDeliveries = [];
  turns.pendingInjections = [];
  turns.injectionAck = null;
  turns.injectionContinuationArmed = false;
  turns.currentTurn = null;
  s.idleTimer = null;
  s.turnIdleTimer = null;
  turns.cumulativeCostUsd = 0;
  s.preserveUnreportedAccounting = false;
  turns.lastTokenUsage = null;
  turns.lastModelName = null;
  s.alive = true;
  s.proc = null;
  return s as ClaudeSession;
}

export const _test = {
  extractAskUserQuestions,
  mergeSubstantialOutput,
  computeSpawnArgs: computeSpawnArgsForSpec,
  makeSessionForTest,
};

// Re-exported for webhook consumer (parity with pre-refactor claude-bridge.ts:286 export)
export { getCurrentPlanFilePath };
export { CancelledError };
