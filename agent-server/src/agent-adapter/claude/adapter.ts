import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface } from 'readline';
import { AGENT_CWD, resolveSpawnCwd } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import { Capability, CAPABILITIES_BY_BACKEND } from '../capabilities.js';
import type {
  AgentCompactResult, AgentProcessSpawner,
  AgentProcessSupervision, EngineAdapter, EngineSpec, Backend, BackgroundTurnSink,
  InjectionAckSink, McpComposition, RateLimitObservation, RateLimitOrigin, RateLimitReporter,
  SpawnedAgentProcess, UserMessage,
} from '../types.js';
import { ClaudeEngineSession, type ClaudeEngineOpenHooks } from './engine.js';
import {
  IDLE_SESSION_TIMEOUT,
  TURN_IDLE_TIMEOUT,
} from './defaults.js';
import { claudeRouteIdentity } from './spawn-args.js';
import {
  claudeProcessLaunch, launchFromSpec, sessionOptionsFromSpec,
  type ClaudeSessionLaunch, type ClaudeSessionOptions,
} from './session-options.js';
import { computeTranscriptPath, readRestoredSessionCost, resolveResumeAgainstTranscript } from './transcript-path.js';
import { clearToolResultsForColdResume } from './transcript-clear.js';
import {
  buildPrompt,
  clearActivePlanFile,
  createStreamDeltaState,
} from './event-parser.js';
import { BgTaskTracker } from './bg-task-tracker.js';
import { ClaudeTurnMachine, type PendingTurn, type TurnHost } from './turn-machine.js';
import {
  type ClaudeTurnCallbacks,
  type TurnTokenUsage,
} from './event-translator.js';
import { ClaudeContextUsageTracker } from './context-usage.js';
import { resolveClaudeCompactWindow } from './compact-window.js';
import { validateClaudeSupplementalMcpConfig } from './mcp-config.js';

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

/** The owner's hooks into one session. */
interface ClaudeSessionHooks {
  /** Pool eviction callbacks. See `ClaudeEngineOpenHooks`. */
  onSelfClose?: ClaudeEngineOpenHooks['onSelfClose'];
  onEvict?: ClaudeEngineOpenHooks['onEvict'];
  /** Host throttle entry point. Absent ⇒ observations are dropped; see `ClaudeAdapterHooks`. */
  onRateLimit?: RateLimitReporter;
}

export interface ClaudeSpawnCompatibility {
  cwd: string;
  /** Endpoint plus credential digests. A mode switch changes it, and a live process cannot be
   *  re-pointed once spawned, so a difference must force a fresh one. */
  routeIdentity: string;
  composition: McpComposition;
  interactionBridge: boolean;
  /** The worker tools are in the bundle set, which is fixed at spawn: toggling team mode must
   *  force a fresh (resumed) process. */
  teamLead: boolean;
  /** Same for a worker's `mark_routine`. */
  teamWorker: boolean;
  tools: string | null;
  pluginCapabilityFingerprint: string | null;
  pluginDirs: string[];
  mcpConfigPaths: string[];
  mcpToolAllowlist: string[] | null;
  supplementalMcpConfigIdentity: string | null;
  /** `--disable-slash-commands`. Part of the identity because the skill surface is fixed at spawn,
   *  so two agents that differ only here must not share a process. */
  disableSkills: boolean;
  /** `--setting-sources`. Null = the CLI's own default set; `[]` = load none. Both are decided at
   *  spawn and cannot be re-pointed afterwards. */
  settingSources: string[] | null;
}

function cloneTextArray(values: string[] | null | undefined): string[] {
  return values ? [...values] : [];
}

function optionalTextArray(values: string[] | null | undefined): string[] | null {
  return values === undefined || values === null ? null : [...values];
}

function compatibilityFromOptions(options: ClaudeSessionOptions): ClaudeSpawnCompatibility {
  const composition = options.mcpComposition;
  return {
    cwd: resolveSpawnCwd(options.cwd),
    routeIdentity: claudeRouteIdentity(options),
    composition,
    interactionBridge: composition === 'direct' && options.isUserInitiated === true,
    teamLead: composition === 'direct' && options.teamLead === true,
    teamWorker: composition === 'direct' && options.teamWorker === true,
    tools: options.tools ?? null,
    pluginCapabilityFingerprint: options.pluginCapabilityFingerprint ?? null,
    pluginDirs: cloneTextArray(options.pluginDirs),
    mcpConfigPaths: cloneTextArray(options.mcpConfigPaths),
    mcpToolAllowlist: optionalTextArray(options.mcpToolAllowlist),
    supplementalMcpConfigIdentity: options.supplementalMcpConfigIdentity ?? null,
    disableSkills: options.disableSkills === true,
    settingSources: optionalTextArray(options.settingSources),
  };
}

/**
 * A string that is equal exactly when two spawn compatibilities are — the pool key
 * `EngineSession.identity` needs. Serialized as an explicit, literal field list rather than
 * `Object.keys`, so the order is stable and a future field cannot silently change the encoding.
 *
 * `null` and `[]` stay distinct for `mcpToolAllowlist` and `settingSources`, and arrays keep their
 * order.
 */
export function claudeCompatibilityIdentity(compatibility: ClaudeSpawnCompatibility): string {
  const fields: Array<[string, unknown]> = [
    ['cwd', compatibility.cwd],
    ['routeIdentity', compatibility.routeIdentity],
    ['composition', compatibility.composition],
    ['interactionBridge', compatibility.interactionBridge],
    ['tools', compatibility.tools],
    ['pluginCapabilityFingerprint', compatibility.pluginCapabilityFingerprint],
    ['supplementalMcpConfigIdentity', compatibility.supplementalMcpConfigIdentity],
    ['disableSkills', compatibility.disableSkills],
    ['pluginDirs', compatibility.pluginDirs],
    ['mcpConfigPaths', compatibility.mcpConfigPaths],
    ['mcpToolAllowlist', compatibility.mcpToolAllowlist],
    ['settingSources', compatibility.settingSources],
  ];
  // Appended only when set, so every session that is neither keeps its existing identity.
  if (compatibility.teamLead) fields.push(['teamLead', true]);
  if (compatibility.teamWorker) fields.push(['teamWorker', true]);
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
    resolveClaudeCompactWindow(cwd, {
      pinned: !!options.pinnedEnv,
      userConfigDir: options.pinnedEnv?.CLAUDE_CONFIG_DIR,
    }),
  );
}

class ClaudeSession implements TurnHost {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  readonly sessionId: string;
  readonly channel: string;
  private readonly sessionKey: string;
  /** Everything the process is (re)spawned with. Fixed for the session's life: a spec that differs
   *  in identity gets a different session from the pool. */
  private readonly options: ClaudeSessionOptions;
  /** Model name requested via --model CLI arg (used as fallback for cost_record). */
  readonly modelName: string | null;
  private readonly compatibility: ClaudeSpawnCompatibility;
  private supervision: AgentProcessSupervision | undefined;
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

  constructor(launch: ClaudeSessionLaunch, hooks: ClaudeSessionHooks = {}) {
    this.channel = launch.channel;
    this.sessionId = launch.sessionId;
    this.sessionKey = launch.sessionKey;
    this.needsResume = launch.needsResume;
    this.options = launch.options;
    this.modelName = launch.options.model || null;
    this.compatibility = compatibilityFromOptions(launch.options);
    this.onSelfClose = hooks.onSelfClose;
    this.onEvict = hooks.onEvict;
    this.onRateLimit = hooks.onRateLimit;
    this.turns = new ClaudeTurnMachine(
      this, createContextUsageTracker(this.modelName, launch.options.cwd, launch.options),
    );
    this.spawnProcess();
  }

  get captureTranscriptLogs(): boolean {
    return this.options.captureTranscriptLogs !== false;
  }

  get anthropicBaseUrl(): string | undefined {
    return this.options.anthropicBaseUrl;
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
    const configPath = this.options.supplementalMcpConfigPath;
    const identity = this.compatibility.supplementalMcpConfigIdentity;
    if (!configPath || !identity) return;
    validateClaudeSupplementalMcpConfig(configPath, identity);
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
    const { cwd, processSpawner, cliPath } = this.options;
    const transcriptPath = computeTranscriptPath(cwd, this.sessionId);
    if (this.needsResume) clearToolResultsForColdResume(transcriptPath, this.sessionId);
    const { args, env } = claudeProcessLaunch({
      channel: this.channel, sessionId: this.sessionId, needsResume: this.needsResume, options: this.options,
    });
    const restoredCost = this.needsResume ? readRestoredSessionCost(transcriptPath, this.sessionId) : 0;
    this.turns.resetCostBaseline(restoredCost);
    log.info(`Spawning persistent process: ${this.sessionId.substring(0, 8)} ${this.needsResume ? `(resume, restored cost $${restoredCost.toFixed(2)})` : '(new)'}`);
    const spawned = spawnClaudeProcess(processSpawner, args, { cwd, env }, cliPath);
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

  // --- Turn delegation. Thin by design: the engine and the unit tests reach the turn through the
  //     session. ---

  handleLine(line: string): void { this.turns.handleLine(line); }

  get currentTurn(): PendingTurn | null { return this.turns.currentTurn; }
  set currentTurn(turn: PendingTurn | null) { this.turns.currentTurn = turn; }

  get backgroundTurnSink(): BackgroundTurnSink | null { return this.turns.backgroundTurnSink; }

  get bgTracker(): BgTaskTracker { return this.turns.bgTracker; }

  /** Read by `pushDerivedTurnEvents` as the turn's accountingSource. */
  get lastModelName(): string | null { return this.turns.lastModelName; }

  get lastTokenUsage(): TurnTokenUsage | null { return this.turns.lastTokenUsage; }

  setBackgroundTurnSink(sink: BackgroundTurnSink): void { this.turns.setBackgroundTurnSink(sink); }

  setInjectionAckSink(sink: InjectionAckSink): void { this.turns.setInjectionAckSink(sink); }

  injectUserMessage(message: UserMessage): boolean { return this.turns.injectUserMessage(message); }

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

/** The resume gate: a pre-registered session id with no transcript yet must create, not resume. */
function gateResume(launch: ClaudeSessionLaunch): ClaudeSessionLaunch {
  const needsResume = resolveResumeForPrint(
    launch.needsResume, launch.sessionId, undefined, launch.options.cwd,
  );
  return { ...launch, needsResume };
}

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
    const session = new ClaudeSession(gateResume(launchFromSpec(spec)), {
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
    const { needsResume, sessionId } = gateResume(launchFromSpec(spec));
    return { needsResume, sessionId };
  }
}

/** Construct a ClaudeSession WITHOUT spawning the `claude` child process, for unit
 *  testing handleLine / continuation routing. Initializes only the fields the line
 *  handlers touch. Transcript capture stays off, so turn streams are no-op sinks.
 *  Callers register cleanup via t.after(() => session.close()) to clear the idle timer. */
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
  s.options = { cwd: AGENT_CWD, mcpComposition: 'direct', captureTranscriptLogs: false };
  turns.bgTracker = new BgTaskTracker();
  turns.streamDeltaState = createStreamDeltaState();
  turns.contextUsageTracker = new ClaudeContextUsageTracker(modelName, autoCompactWindow);
  turns.backgroundTurnSink = null;
  turns.pendingInjections = [];
  turns.injectionAck = null;
  turns.injectionContinuationArmed = false;
  turns.currentTurn = null;
  s.idleTimer = null;
  s.turnIdleTimer = null;
  turns.cumulativeCostUsd = 0;
  turns.lastTokenUsage = null;
  turns.lastModelName = null;
  s.alive = true;
  s.proc = null;
  return s as ClaudeSession;
}

export const _test = {
  makeSessionForTest,
};
