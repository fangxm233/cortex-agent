// input:  cwd, composition, prompts, tools, TUI deps
// output: interactive Claude session with spawn policy
// pos:    Runs Claude TUI sessions under tmux
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import * as path from 'path';
import { createLogger } from '@core/log.js';
import { TmuxControl } from './tmux-control.js';
import { JsonlTail, JsonlEventNormalizer } from './jsonl-tail.js';
import type { IdentityJsonValue } from '../../domain/agent-run/identity.js';
import {
  CancelledError,
  TUI_TMUX_NAME_PREFIX,
  TUI_JSONL_BASE,
  IDLE_SESSION_TIMEOUT,
  MAX_TIMEOUT,
  TURN_IDLE_TIMEOUT,
  JSONL_FIRST_EVENT_TIMEOUT,
  PASTE_SUBMIT_DELAY_MS,
  PANE_READY_TIMEOUT,
  PANE_READY_POLL_MS,
  PANE_READY_MARKER,
} from './defaults.js';
import { buildSpawnArgs, buildClaudeEnv, type CortexAgentContext } from './spawn-args.js';
import { validateClaudeSupplementalMcpConfig } from './mcp-config.js';
import { buildPrompt, mergeSubstantialOutput } from './event-parser.js';
import type { NormalizedEvent } from '../normalize/event-types.js';
import { resolveMcpComposition, type McpComposition } from '../types.js';
import { usageToCost } from './cost-from-usage.js';

const log = createLogger('claude-tui');

// =====================================================================================
//  Types
// =====================================================================================

/** Subset of JsonlTail surface the session depends on — lets tests inject a mock. */
export interface JsonlTailLike extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly path?: string;
}

export interface TuiSessionDeps {
  tmux: TmuxControl;
  /** Factory creating a tail for the given jsonl path. Defaults to real JsonlTail in production. */
  tailFactory: (jsonlPath: string) => JsonlTailLike;
  /** @deprecated No longer used — the jsonl file appears only after the first submit, so there is
   *  nothing to wait for at spawn. Kept so existing callers/tests construct without changes. */
  waitForJsonlMs?: number;
  /** Fast-fail window (ms) for a fresh turn producing no jsonl output. Tests override with a small
   *  value. Defaults to JSONL_FIRST_EVENT_TIMEOUT. */
  firstEventTimeoutMs?: number;
  /** Delay (ms) between pasting the prompt and sending Enter. Tests set 0 to submit synchronously.
   *  Defaults to PASTE_SUBMIT_DELAY_MS (needed so Claude's Ink TUI registers the paste). */
  pasteSubmitDelayMs?: number;
  /** Max time (ms) to poll capture-pane for the Claude TUI readiness marker after a fresh spawn,
   *  before the first paste. Tests set 0 to skip the wait (mocked tmux never renders a pane).
   *  Defaults to PANE_READY_TIMEOUT. */
  paneReadyTimeoutMs?: number;
  /** Poll interval (ms) for the pane-readiness wait. Defaults to PANE_READY_POLL_MS. */
  paneReadyPollMs?: number;
}

export interface ClaudeTuiSessionConfig {
  channel: string;
  sessionId: string;
  /** Pool key used to deduplicate sessions per channel/thread (DR-0008). */
  sessionKey: string;
  /** Working directory of the claude process — must match the cwd used in past sessions for --resume.
   *  Determines jsonl path via Claude's `~/.claude/projects/<dash-encoded-cwd>/<sessionId>.jsonl` convention. */
  cwd: string;
  /** True iff the session is being resumed (`--resume`) rather than freshly created (`--session-id`). */
  needsResume: boolean;
  // -- CLI passthroughs (subset of ClaudeSpawnOptions, all optional) --
  tools?: string | null;
  systemPrompt?: string | null;
  appendSystemPrompt?: string | null;
  model?: string | null;
  claudeAgent?: string | null;
  pluginDirs?: string[] | null;
  outputStyle?: string | null;
  extraOption?: Record<string, string> | null;
  /** Thinking level from the profile's `thinking` field → `--effort <level>`. Absent → no flag. */
  thinking?: string | null;
  mcpComposition?: McpComposition;
  mcpConfigPaths?: string[] | null;
  supplementalMcpConfigPath?: string | null;
  disableHooks?: boolean;
  benchmarkPolicyGuard?: IdentityJsonValue;
  pluginCapabilityFingerprint?: string | null;
  supplementalMcpConfigIdentity?: string | null;
  // -- runtime context surfaced to MCP servers via env --
  callbackSource?: string | null;
  scheduleTaskId?: string | null;
  anthropicBaseUrl?: string;
  extraEnv?: Record<string, string>;
  context?: CortexAgentContext;
  // -- deps --
  deps: TuiSessionDeps;
}

export interface TuiAgentResult {
  sessionId: string;
  total_cost_usd: number | null;
  num_turns: number | null;
  rateLimited: boolean;
  rateLimitMessage: string | null;
  planFilePath: string | null;
  enteredPlanMode: boolean;
  exitedPlanMode: boolean;
  askUserQuestions: Array<{ toolUseId: string; questions: any[] }>;
  finalOutput: string | null;
}

export interface SendMessageOptions {
  onProgress?: ((progress: { num_turns: number; total_cost_usd: number | null; duration_ms: number | null }) => void) | null;
  onAssistantMessage?: ((text: string) => void) | null;
  onToolUse?: ((name: string, input: any) => void) | null;
  /** Streaming callback: fires for EVERY NormalizedEvent including turn_complete. Used by adapter-level
   *  wrappers (ClaudeAdapter.spawn) to plumb events into the per-turn event stream. */
  onEvent?: ((event: NormalizedEvent) => void) | null;
  files?: any[];
}

interface PendingTurn {
  resolve: (value: TuiAgentResult) => void;
  reject: (error: Error) => void;
  enteredPlanMode: boolean;
  exitedPlanMode: boolean;
  planFilePath: string | null;
  askUserQuestions: Array<{ toolUseId: string; questions: any[] }>;
  finalOutput: string | null;
  longestOutput: string | null;
  turnCount: number;
  turnTotalCost: number | null;
  killed: boolean;
  options: SendMessageOptions;
}

// =====================================================================================
//  ClaudeTuiSession
// =====================================================================================

/**
 * TUI-mode Claude session. Each instance owns one tmux session and one jsonl tail. Turns run
 * serially through {@link sendMessage}; cancellation via {@link cancelCurrentTurn} sends Esc + C-u
 * to interrupt the in-flight model response and clear the prompt buffer.
 *
 * @see DR-0012 §3.2 — turn lifecycle: paste → Enter → await turn_complete → resolve.
 */
export class ClaudeTuiSession {
  readonly channel: string;
  readonly sessionId: string;
  readonly sessionKey: string;
  readonly cwd: string;
  readonly mcpComposition: McpComposition;
  readonly tmuxName: string;
  readonly jsonlPath: string;
  readonly pluginCapabilityFingerprint: string | null;
  readonly supplementalMcpConfigIdentity: string | null;
  readonly pluginDirs: string[];
  readonly mcpConfigPaths: string[];

  private readonly tmux: TmuxControl;
  private readonly tailFactory: (p: string) => JsonlTailLike;
  private readonly firstEventTimeoutMs: number;
  private readonly pasteSubmitDelayMs: number;
  private readonly paneReadyTimeoutMs: number;
  private readonly paneReadyPollMs: number;
  private readonly config: ClaudeTuiSessionConfig;

  private tail: JsonlTailLike | null = null;
  private normalizer: JsonlEventNormalizer = new JsonlEventNormalizer();
  private alive = false;
  private needsResume: boolean;

  private currentTurn: PendingTurn | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private maxTimer: NodeJS.Timeout | null = null;
  private turnIdleTimer: NodeJS.Timeout | null = null;
  private firstEventTimer: NodeJS.Timeout | null = null;

  constructor(config: ClaudeTuiSessionConfig) {
    this.config = config;
    this.channel = config.channel;
    this.sessionId = config.sessionId;
    this.sessionKey = config.sessionKey;
    this.cwd = config.cwd;
    this.mcpComposition = resolveMcpComposition(config.mcpComposition, config.context?.useCoreMcp);
    this.needsResume = config.needsResume;
    this.tmux = config.deps.tmux;
    this.tailFactory = config.deps.tailFactory;
    this.firstEventTimeoutMs = config.deps.firstEventTimeoutMs ?? JSONL_FIRST_EVENT_TIMEOUT;
    this.pasteSubmitDelayMs = config.deps.pasteSubmitDelayMs ?? PASTE_SUBMIT_DELAY_MS;
    this.paneReadyTimeoutMs = config.deps.paneReadyTimeoutMs ?? PANE_READY_TIMEOUT;
    this.paneReadyPollMs = config.deps.paneReadyPollMs ?? PANE_READY_POLL_MS;

    this.tmuxName = `${TUI_TMUX_NAME_PREFIX}${this.sessionId}`;
    this.jsonlPath = computeJsonlPath(this.cwd, this.sessionId);
    this.pluginCapabilityFingerprint = config.pluginCapabilityFingerprint ?? null;
    this.supplementalMcpConfigIdentity = config.supplementalMcpConfigIdentity ?? null;
    this.pluginDirs = [...(config.pluginDirs ?? [])];
    this.mcpConfigPaths = [...(config.mcpConfigPaths ?? [])];
  }

  isAlive(): boolean {
    return this.alive && this.tmux.hasSession(this.tmuxName);
  }

  // -----------------------------------------------------------------------------
  //  Lifecycle
  // -----------------------------------------------------------------------------

  private async ensureSpawned(): Promise<void> {
    if (this.alive && this.tmux.hasSession(this.tmuxName)) return;
    this.validateSupplementalMcpConfig();
    const argv = this.tuiSpawnArgs();
    const env = this.tuiSpawnEnv();
    this.removeStaleTmuxSession();
    this.spawnTmux(argv, env);
    await this.replaceTail();
    await this.waitForPaneReady();
    this.activateSpawnedSession();
  }

  private validateSupplementalMcpConfig(): void {
    const configPath = this.config.supplementalMcpConfigPath;
    const identity = this.supplementalMcpConfigIdentity;
    if (configPath && identity) validateClaudeSupplementalMcpConfig(configPath, identity);
  }

  private tuiSpawnArgs(): string[] {
    return buildSpawnArgs({
      tools: this.config.tools ?? null,
      systemPrompt: this.config.systemPrompt ?? null,
      appendSystemPrompt: this.config.appendSystemPrompt ?? null,
      model: this.config.model ?? null,
      claudeAgent: this.config.claudeAgent ?? null,
      pluginDirs: this.config.pluginDirs ?? null,
      outputStyle: this.config.outputStyle ?? null,
      extraOption: this.config.extraOption ?? null,
      thinking: this.config.thinking ?? null,
      mcpComposition: this.mcpComposition,
      mcpConfigPaths: this.config.mcpConfigPaths ?? null,
      supplementalMcpConfigPath: this.config.supplementalMcpConfigPath ?? null,
      disableHooks: this.config.disableHooks,
      benchmarkPolicyGuard: this.config.benchmarkPolicyGuard,
      needsResume: this.needsResume,
      sessionId: this.sessionId,
      mode: 'tui',
    });
  }

  private tuiSpawnEnv(): Record<string, string> {
    const env = buildClaudeEnv(
      this.channel,
      this.sessionId,
      this.config.callbackSource ?? null,
      this.config.scheduleTaskId ?? null,
      this.config.anthropicBaseUrl,
      this.config.extraEnv,
      this.config.context,
    );
    // Mark TUI mode for downstream MCP server self-detection.
    env.CORTEX_TUI_MODE = '1';
    // Filter env to string-only entries (tmux -e requires KEY=VAL strings).
    const stringEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') stringEnv[key] = value;
    }
    return stringEnv;
  }

  /** Remove a tmux session left behind by a failed tail start or external orphaning. */
  private removeStaleTmuxSession(): void {
    if (!this.tmux.hasSession(this.tmuxName)) return;
    log.warn(`ensureSpawned: stale tmux session ${this.tmuxName} present while not alive — killing before respawn`);
    this.tmux.killSession(this.tmuxName);
  }

  private spawnTmux(argv: string[], env: Record<string, string>): void {
    log.info(`Spawning TUI session ${this.tmuxName} (${this.needsResume ? 'resume' : 'new'})`);
    this.tmux.newSession({
      name: this.tmuxName,
      command: ['claude', ...argv],
      cwd: this.cwd,
      env,
    });
    // Every later recovery must resume the transcript created by this spawn.
    this.needsResume = true;
  }

  /** Replace spawn-bound tail and normalizer state without waiting for the transcript to appear. */
  private async replaceTail(): Promise<void> {
    if (this.tail) {
      try { await this.tail.stop(); } catch { /* best effort */ }
      this.tail = null;
    }
    this.normalizer = new JsonlEventNormalizer();
    this.tail = this.tailFactory(this.jsonlPath);
    this.tail.on('event', (raw) => this.handleRawEvent(raw));
    await this.tail.start();
  }

  private activateSpawnedSession(): void {
    this.alive = true;
    this.resetIdleTimer();
    this.maxTimer = setTimeout(() => {
      log.info(`TUI session ${this.sessionId.substring(0, 8)} hit max timeout, killing`);
      this.kill();
    }, MAX_TIMEOUT);
    // Long-lived timers must not keep the event loop alive.
    if (typeof this.maxTimer.unref === 'function') this.maxTimer.unref();
  }

  /**
   * Poll capture-pane until the Claude TUI prompt is interactive (or the timeout elapses). Returns
   * as soon as {@link PANE_READY_MARKER} appears. On timeout it logs and returns anyway — better to
   * attempt the paste than to hard-fail, and the first-event watchdog still bounds a dead session.
   * Tests pass paneReadyTimeoutMs=0 to skip entirely (mocked tmux renders no pane).
   */
  private async waitForPaneReady(): Promise<void> {
    if (this.paneReadyTimeoutMs <= 0) return;
    const deadline = Date.now() + this.paneReadyTimeoutMs;
    while (Date.now() < deadline) {
      let pane = '';
      try { pane = this.tmux.capturePane(this.tmuxName); } catch { /* pane not ready yet */ }
      if (PANE_READY_MARKER.test(pane)) return;
      await new Promise(r => setTimeout(r, this.paneReadyPollMs));
    }
    log.warn(`TUI session ${this.sessionId.substring(0, 8)} pane not ready within ${this.paneReadyTimeoutMs}ms — pasting anyway`);
  }

  // -----------------------------------------------------------------------------
  //  Turn execution
  // -----------------------------------------------------------------------------

  async sendMessage(userMessage: string, options: SendMessageOptions): Promise<TuiAgentResult> {
    if (this.currentTurn) {
      throw new Error(`TUI session ${this.tmuxName} already has a turn in flight`);
    }
    await this.ensureSpawned();
    this.resetIdleTimer();

    const prompt = buildPrompt(userMessage, options.files || []);

    const turnPromise = new Promise<TuiAgentResult>((resolve, reject) => {
      this.currentTurn = {
        resolve, reject,
        enteredPlanMode: false,
        exitedPlanMode: false,
        planFilePath: null,
        askUserQuestions: [],
        finalOutput: null,
        longestOutput: null,
        turnCount: 0,
        turnTotalCost: null,
        killed: false,
        options,
      };
    });

    // Paste prompt, let the Ink TUI register the bracketed paste, THEN submit with Enter.
    // Enter sent immediately after paste-buffer is swallowed and the prompt never submits
    // (DR-0012 soak finding on Claude 2.1.160) — hence the settle delay.
    this.tmux.pasteText(this.tmuxName, prompt);
    if (this.pasteSubmitDelayMs > 0) {
      await new Promise(r => setTimeout(r, this.pasteSubmitDelayMs));
    }
    this.tmux.sendKeys(this.tmuxName, 'Enter');
    this.startTurnIdleTimer();
    this.armFirstEventWatchdog();

    return turnPromise;
  }

  /**
   * Cancel the currently in-flight turn. Sends Escape (interrupts model generation), then C-u
   * (clears any text still in the prompt buffer — Esc alone does NOT clear it; without this step
   * the next sendMessage would concatenate with the stale buffer contents).
   *
   * @see DR-0012 §3.5 — full cancel protocol.
   */
  async cancelCurrentTurn(): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) return;
    turn.killed = true;
    try {
      this.tmux.sendKeys(this.tmuxName, 'Escape');
      await new Promise(r => setTimeout(r, 200));
      this.tmux.sendKeys(this.tmuxName, 'C-u');
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      log.warn(`cancel send-keys failed: ${(e as Error).message}`);
    }
    this.currentTurn = null;
    if (this.turnIdleTimer) { clearTimeout(this.turnIdleTimer); this.turnIdleTimer = null; }
    this.clearFirstEventWatchdog();
    turn.reject(new CancelledError());
  }

  // -----------------------------------------------------------------------------
  //  Event handling — jsonl tail → normalizer → turn state
  // -----------------------------------------------------------------------------

  private handleRawEvent(raw: any): void {
    // First jsonl line of the turn proves Claude started producing output — disarm the fast-fail
    // watchdog; from here the per-event turnIdleTimer governs stalls.
    this.clearFirstEventWatchdog();
    this.resetIdleTimer();
    this.bumpTurnIdleTimer();
    const events = this.normalizer.consume(raw);
    for (const ev of events) this.handleNormalizedEvent(ev);
  }

  private handleNormalizedEvent(ev: NormalizedEvent): void {
    const turn = this.currentTurn;
    if (!turn) {
      // Out-of-turn events are dropped (logged for diagnostics).
      log.info(`event outside turn: ${ev.type}`);
      return;
    }
    // Fire onEvent first so adapter-level wrappers see EVERY event, including ones
    // (cost_record, turn_complete, tool_result, ask_user_question, plan_*) that don't
    // have a dedicated per-turn convenience callback.
    if (turn.options.onEvent) {
      try { turn.options.onEvent(ev); } catch (e) { log.warn(`onEvent threw: ${(e as Error).message}`); }
    }
    switch (ev.type) {
      case 'assistant_text': {
        turn.finalOutput = ev.text;
        if (!turn.longestOutput || ev.text.length > turn.longestOutput.length) {
          turn.longestOutput = ev.text;
        }
        try { turn.options.onAssistantMessage?.(ev.text); } catch (e) { log.warn(`onAssistantMessage threw: ${(e as Error).message}`); }
        break;
      }
      case 'tool_use': {
        try { turn.options.onToolUse?.(ev.name, ev.input); } catch (e) { log.warn(`onToolUse threw: ${(e as Error).message}`); }
        break;
      }
      case 'plan_mode_entered': {
        turn.enteredPlanMode = true;
        break;
      }
      case 'plan_written': {
        turn.planFilePath = ev.path;
        break;
      }
      case 'ask_user_question': {
        turn.askUserQuestions.push({ toolUseId: ev.toolUseId, questions: ev.questions });
        break;
      }
      case 'turn_progress': {
        turn.turnCount = ev.numTurns;
        try { turn.options.onProgress?.({ num_turns: ev.numTurns, total_cost_usd: null, duration_ms: null }); } catch (e) { log.warn(`onProgress threw: ${(e as Error).message}`); }
        break;
      }
      case 'cost_record': {
        turn.turnTotalCost = ev.cost_usd;
        break;
      }
      case 'turn_complete': {
        // turn_complete may arrive with cost included; prefer cost_record's value if both present
        if (ev.totalCostUsd != null && turn.turnTotalCost == null) {
          turn.turnTotalCost = ev.totalCostUsd;
        }
        this.completeTurn(turn);
        break;
      }
      case 'tool_result':
      case 'session_started':
      case 'rate_limit':
      case 'error':
        // Not surfaced through AgentResult; could be wired to events stream later.
        break;
    }
  }

  private completeTurn(turn: PendingTurn): void {
    if (this.currentTurn !== turn) return;
    if (this.turnIdleTimer) { clearTimeout(this.turnIdleTimer); this.turnIdleTimer = null; }
    this.clearFirstEventWatchdog();
    this.currentTurn = null;
    // Note: needsResume is set to true in ensureSpawned() after first spawn — that flag stays
    // true for the rest of this ClaudeTuiSession's lifetime so recovery from tmux death uses
    // --resume rather than --session-id (which would collide with the persisted jsonl).

    const finalOutput = mergeSubstantialOutput(turn.finalOutput, turn.longestOutput);
    const result: TuiAgentResult = {
      sessionId: this.sessionId,
      total_cost_usd: turn.turnTotalCost,
      num_turns: turn.turnCount,
      rateLimited: false,
      rateLimitMessage: null,
      planFilePath: turn.planFilePath,
      enteredPlanMode: turn.enteredPlanMode,
      exitedPlanMode: turn.exitedPlanMode,
      askUserQuestions: turn.askUserQuestions,
      finalOutput,
    };
    turn.resolve(result);
  }

  // -----------------------------------------------------------------------------
  //  Timers
  // -----------------------------------------------------------------------------

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log.info(`TUI session ${this.sessionId.substring(0, 8)} idle for ${IDLE_SESSION_TIMEOUT}ms, closing`);
      this.close();
    }, IDLE_SESSION_TIMEOUT);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  private startTurnIdleTimer(): void {
    if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
    this.turnIdleTimer = setTimeout(() => {
      log.info(`TUI session ${this.sessionId.substring(0, 8)} turn idle for ${TURN_IDLE_TIMEOUT}ms, killing`);
      this.kill();
    }, TURN_IDLE_TIMEOUT);
    if (typeof this.turnIdleTimer.unref === 'function') this.turnIdleTimer.unref();
  }

  private bumpTurnIdleTimer(): void {
    if (!this.turnIdleTimer) return;
    this.startTurnIdleTimer();
  }

  /**
   * One-shot fast-fail watchdog for the window between submitting a prompt and the first jsonl
   * event. Replaces the old 5s file-appear wait that used to fail fast at spawn — now that the
   * tail is non-blocking, a Claude that never starts would otherwise hang until TURN_IDLE_TIMEOUT
   * (60 min). On fire: reject the pending turn with a descriptive error and kill the session.
   * Disarmed by {@link clearFirstEventWatchdog} on the first jsonl event of the turn.
   */
  private armFirstEventWatchdog(): void {
    this.clearFirstEventWatchdog();
    this.firstEventTimer = setTimeout(() => {
      const turn = this.currentTurn;
      if (!turn) return;
      log.warn(`TUI session ${this.sessionId.substring(0, 8)} produced no jsonl output within ${this.firstEventTimeoutMs}ms of submit — killing`);
      // Detach the turn before kill() so it surfaces this descriptive error rather than kill()'s
      // generic CancelledError (which the adapter treats as a silent user cancel).
      this.currentTurn = null;
      if (this.turnIdleTimer) { clearTimeout(this.turnIdleTimer); this.turnIdleTimer = null; }
      turn.reject(new Error(`claude produced no jsonl output within ${this.firstEventTimeoutMs}ms of submit (session may have failed to start)`));
      this.kill();
    }, this.firstEventTimeoutMs);
    if (typeof this.firstEventTimer.unref === 'function') this.firstEventTimer.unref();
  }

  private clearFirstEventWatchdog(): void {
    if (this.firstEventTimer) { clearTimeout(this.firstEventTimer); this.firstEventTimer = null; }
  }

  // -----------------------------------------------------------------------------
  //  Shutdown
  // -----------------------------------------------------------------------------

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
    this.clearFirstEventWatchdog();
    this.idleTimer = this.maxTimer = this.turnIdleTimer = null;
    this.alive = false;
    if (this.tail) {
      this.tail.stop().catch(() => { /* best effort */ });
      this.tail = null;
    }
    // graceful: do NOT tmux kill-session — let the user keep observing
    if (this.currentTurn) {
      const t = this.currentTurn;
      this.currentTurn = null;
      t.reject(new CancelledError());
    }
  }

  kill(): boolean {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
    this.clearFirstEventWatchdog();
    this.idleTimer = this.maxTimer = this.turnIdleTimer = null;
    const wasAlive = this.alive;
    this.alive = false;
    if (this.tail) {
      this.tail.stop().catch(() => {});
      this.tail = null;
    }
    try { this.tmux.killSession(this.tmuxName); } catch { /* best effort */ }
    if (this.currentTurn) {
      const t = this.currentTurn;
      this.currentTurn = null;
      t.reject(new CancelledError());
    }
    return wasAlive;
  }
}

// =====================================================================================
//  Jsonl path computation
// =====================================================================================

/**
 * Mirror Claude Code's convention: jsonl session transcript lives at
 *   ~/.claude/projects/<dash-encoded-cwd>/<sessionId>.jsonl
 * where dash-encoded-cwd is the absolute cwd with BOTH `/` AND `.` replaced by `-`
 * (leading slash → leading `-`; dotfiles like `.cortex` → `--cortex`).
 *
 * Empirically verified against `~/.claude/projects/` directory contents on Claude 2.1.141+:
 *   `/home/fangxin/.cortex`     → `-home-fangxin--cortex`
 *   `/home/fangxin/Cortex`      → `-home-fangxin-Cortex`
 *   `/tmp/cortex-spike-tui`     → `-tmp-cortex-spike-tui`
 *
 * The DR-0012 spike ran in `/tmp/cortex-spike-tui` (no dots), so the dot-encoding rule was
 * missed initially — without it, sessions under `~/.cortex/` (the default DATA_DIR) would
 * have JsonlTail watching a non-existent path and timing out on first turn.
 */
export function computeJsonlPath(cwd: string, sessionId: string): string {
  const encoded = cwd.replace(/[/.]/g, '-');
  return path.join(TUI_JSONL_BASE, encoded, `${sessionId}.jsonl`);
}

/**
 * Decide whether a TUI session should spawn with `--resume <id>` (vs `--session-id <id>`).
 *
 * `--resume` only succeeds when a Claude transcript already exists for that id. A *fresh* TUI
 * session pre-registers its channel→sessionId mapping BEFORE the first Claude turn (so transcript
 * replay / session naming work), which makes the orchestrator's generic "a session mapping exists
 * ⇒ resume" heuristic ask to resume an id that has no transcript yet — Claude then exits with
 * "No conversation found with session ID: <id>". Gating the resume request on the transcript
 * actually existing keeps the first turn on `--session-id` (create) and lets only later turns /
 * reconnects use `--resume`. Self-healing: a deleted transcript also correctly falls back to create.
 */
export function resolveTuiResume(
  requestedResume: boolean,
  jsonlPath: string,
  exists: (p: string) => boolean = existsSync,
): boolean {
  return requestedResume && exists(jsonlPath);
}

/**
 * Convenience factory: real JsonlTail wired to the path. Used by production code; tests inject
 * a custom factory instead.
 */
export function defaultTailFactory(jsonlPath: string): JsonlTailLike {
  return new JsonlTail(jsonlPath) as unknown as JsonlTailLike;
}
