// input:  AgentSpawnConfig, session keys, injectable spawner
// output: PIAdapter + PISession + switch_session API + assistant_delta streaming preview
// pos:    PI CLI session pool and AgentAdapter implementation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { spawn as defaultSpawn, execSync, type ChildProcess, type SpawnOptions } from 'child_process';
import { mkdirSync, readdirSync, openSync, readSync, closeSync } from 'fs';
import * as path from 'path';
import { DATA_DIR, INSTALL_ROOT } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { Capability, CAPABILITIES_BY_BACKEND } from '../capabilities.js';
import type { AgentAdapter, AgentProcess, AgentSpawnConfig, Backend, UserMessage } from '../types.js';
import type { AgentResult, AskUserQuestionInfo } from '@core/types/agent-types.js';
import type { NormalizedEvent } from '../normalize/event-types.js';
import { buildSpawnArgs } from './spawn-args.js';
import { createLineSplitter, encodeCommand } from './framing.js';
import { piRpcLineToNormalized, createPIEventParserState, type PIEventParserState } from './event-parser.js';
import { PI_AGENT_DIR, PI_SESSIONS_DIR, writeProvidersConfig, buildProviderOverrides, ensureAuthVisible } from './agent-dir.js';
import { parsePiListModelsOutput } from '@core/gateway-generator.js';
import { buildPrompt } from '../normalize/prompt-builder.js';
import { fromCanonical } from '../normalize/tool-names.js';

const log = createLogger('pi-adapter');

function buildPromptText(msg: UserMessage): string {
  return buildPrompt(msg.text, msg.attachments ?? []);
}

/**
 * Discover unique PI provider names by shelling out to `pi --list-models`. Called at spawn time
 * so the multi-provider models.json reflects whatever the user has currently authenticated to.
 *
 * PI writes the table to stderr — merge via 2>&1. Returns empty array on any failure (PI not
 * installed, timeout, parse error); the caller logs a warning and proceeds without overriding
 * models.json, which means the PI subprocess will fall back to direct upstream calls.
 *
 * Uses the user's real ~/.pi/agent/ for discovery (no PI_CODING_AGENT_DIR override) — symmetric
 * with cortex init's gateway-generator.scanPIViaListModels(). ensureAuthVisible() then mirrors
 * the auth file into PI_AGENT_DIR so the actual spawn can see those credentials.
 */
function discoverPIProviders(): string[] {
  try {
    const stdout = execSync('pi --list-models 2>&1', {
      timeout: 10_000,
      encoding: 'utf-8',
      // Intentionally do NOT set PI_CODING_AGENT_DIR — read user's real PI config.
      env: { ...process.env, PI_CODING_AGENT_DIR: '' },
    });
    const models = parsePiListModelsOutput(stdout);
    const uniq = new Set<string>();
    for (const m of models) uniq.add(m.provider);
    return Array.from(uniq);
  } catch (err) {
    log.info(`pi --list-models failed at spawn: ${(err as Error).message ?? 'unknown'}`);
    return [];
  }
}

/**
 * Does a PI session file matching `sessionId` exist under `sessionDir`? PI names session files
 * `<timestamp>_<piId>.jsonl` (the full backend id is embedded in the filename), so the filename
 * check is the reliable fast path. As a fallback (naming drift / partial ids) it reads a bounded
 * prefix of each `.jsonl` and matches the header line's `id` field. Any FS error → false (treat as
 * absent, i.e. start fresh — the safe default this guard exists to enforce).
 */
function piSessionFileExists(sessionDir: string, sessionId: string): boolean {
  if (!sessionId) return false;
  let files: string[];
  try {
    files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
  // Fast path: the backend id is embedded in PI's filename.
  if (files.some((f) => f.includes(sessionId))) return true;
  // Fallback: match the header line's `id` field via a bounded prefix read (avoids loading a
  // potentially large transcript just to inspect the first line).
  for (const f of files) {
    let fd: number | null = null;
    try {
      fd = openSync(path.join(sessionDir, f), 'r');
      const buf = Buffer.alloc(8192);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.toString('utf8', 0, n).split('\n', 1)[0];
      const obj = JSON.parse(firstLine) as Record<string, unknown>;
      if (obj && (obj.id === sessionId || obj.sessionId === sessionId)) return true;
    } catch {
      /* ignore unreadable / non-JSON header */
    } finally {
      if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    }
  }
  return false;
}

const DEFAULT_PI_BINARY = 'pi';
// DEFAULT_SESSION_DIR: sessionId.jsonl files are stored here (convention: <sessionDir>/<sessionId>.jsonl).
// Sessions stored under logs/sessions-pi/; PI_CODING_AGENT_DIR points to data/ for models.json.
const DEFAULT_SESSION_DIR = PI_SESSIONS_DIR;
// PI extensions point at compiled dist/.js files — PI's extension loader accepts both .ts and .js
// (pi-coding-agent dist/core/extensions/loader.js:367). Shipping .js avoids depending on src/ in
// the installed package (package.json#files only ships dist/ + defaults/).
const MCP_BRIDGE_PATH = path.join(INSTALL_ROOT, 'dist/agent-adapter/pi/mcp-bridge.js');
const TOOL_SHIMS_PATH = path.join(INSTALL_ROOT, 'dist/agent-adapter/pi/tool-shims.js');
const HOOK_BRIDGE_PATH = path.join(INSTALL_ROOT, 'dist/agent-adapter/pi/hook-bridge.js');
// Per FINDINGS.md §S1, pi rpc exits cleanly on stdin close; observed bootstrap cost ≈ 500 ms.
// 5 s is a safety margin; if pi does not exit in that window close() falls back to SIGTERM.
const CLOSE_EXIT_WAIT_MS = 5000;
// switch_session response timeout: if pi does not ack within this window, reject the pending promise.
const SWITCH_SESSION_TIMEOUT_MS = 5000;
const PI_IDLE_SESSION_TIMEOUT = 65 * 60 * 1000;
const PI_TURN_IDLE_TIMEOUT = 60 * 60 * 1000;
const PI_MAX_TIMEOUT = 30_000_000;

/** Result of a switch_session RPC: ok=true when pi acked, cancelled=true when an in-flight agent was preempted. */
type SwitchResult = { ok: boolean; cancelled: boolean };

/**
 * PI-specific extension of AgentProcess that exposes sendExtensionUiResponse.
 * Callers that need to respond to ask_user_question events (plan approval, interactive questions)
 * can use this method to send extension_ui_response back to the PI subprocess.
 * Payload fields depend on the dialog method (rpc.md §extension_ui):
 *   select/input/editor: { value: string } or { cancelled: true }
 *   confirm:             { confirmed: boolean } or { cancelled: true }
 */
export interface PIAgentProcess extends AgentProcess {
  sendExtensionUiResponse(id: string, payload: Record<string, unknown>): void;
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

interface PISessionOptions {
  sessionKey: string;
  sessionDir: string;
  cliArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawner: SpawnFn;
  /** Shared session-path registry; bootstrap handler registers sessionId → path on first session_started. */
  registry: Map<string, string>;
  /** sessionDir used to derive paths; passed here so PISession does not need a PIAdapter back-reference. */
  registrySessionDir: string;
  /** Called when session self-closes (idle timeout, max timeout) so the adapter can remove it from the pool. */
  onClose?: (sessionKey: string) => void;
}

class EventQueue {
  private readonly pending: NormalizedEvent[] = [];
  private readonly waiters: ((r: IteratorResult<NormalizedEvent>) => void)[] = [];
  private closed = false;

  push(evt: NormalizedEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: evt, done: false });
    else this.pending.push(evt);
  }

  next(): Promise<IteratorResult<NormalizedEvent>> {
    const buffered = this.pending.shift();
    if (buffered) return Promise.resolve({ value: buffered, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise<IteratorResult<NormalizedEvent>>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) {
      w({ value: undefined, done: true });
    }
  }
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
  /** Accumulator for the current in-flight turn. Resolved/rejected by handleRawLine. */
  private pendingTurn: {
    resolve: (r: AgentResult) => void;
    reject: (e: Error) => void;
    planFilePath: string | null;
    askUserQuestions: AskUserQuestionInfo[];
    rateLimited: boolean;
    numTurns: number | null;
    totalCostUsd: number | null;
  } | null = null;

  constructor(opts: PISessionOptions) {
    this.sessionKey = opts.sessionKey;
    this.registry = opts.registry;
    this.registrySessionDir = opts.registrySessionDir;
    this.onClose = opts.onClose;
    this.streamDeltas = process.env['CORTEX_STREAM_DELTAS'] !== '0';

    this.proc = opts.spawner(DEFAULT_PI_BINARY, opts.cliArgs, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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

    // Intercept switch_session response BEFORE event-parser: event-parser silently drops
    // successful non-bootstrap responses (return []), so switch_session acks must be
    // correlated here to resolve/reject the pending promise.
    if (this.pendingSwitch !== null) {
      let obj: unknown = null;
      try { obj = JSON.parse(line); } catch { /* fall through to event-parser */ }
      if (obj && typeof obj === 'object') {
        const r = obj as Record<string, unknown>;
        if (
          r['type'] === 'response' &&
          r['command'] === 'switch_session' &&
          r['id'] === this.pendingSwitch.id
        ) {
          const entry = this.pendingSwitch;
          this.pendingSwitch = null;
          if (this.pendingSwitchTimer !== null) {
            clearTimeout(this.pendingSwitchTimer);
            this.pendingSwitchTimer = null;
          }
          const data = r['data'];
          const cancelled =
            data && typeof data === 'object'
              ? Boolean((data as Record<string, unknown>)['cancelled'])
              : false;
          entry.resolve({ ok: r['success'] === true, cancelled });
          return;
        }
      }
    }

    for (const evt of piRpcLineToNormalized(line, this.parserState)) {
      if (evt.type === 'session_started' && this.sessionId === null) {
        this.sessionId = evt.sessionId;
        this.currentSessionId = evt.sessionId;
        // Use sessionFile from bootstrap if available; fall back to legacy path guess.
        if (evt.sessionFile) {
          this.sessionFile = evt.sessionFile;
          this.registry.set(evt.sessionId, evt.sessionFile);
        } else {
          this.registry.set(evt.sessionId, path.join(this.registrySessionDir, `${evt.sessionId}.jsonl`));
        }
      }

      // Accumulate turn result data for pending send() promise.
      if (this.pendingTurn !== null) {
        if (evt.type === 'plan_written') {
          this.pendingTurn.planFilePath = evt.path;
        } else if (evt.type === 'ask_user_question') {
          // Do NOT accumulate in pendingTurn.askUserQuestions: PI ask_user_question
          // events are handled in real-time via the facade event loop → onAskUserQuestion
          // callback → Slack interaction → sendExtensionUiResponse. Accumulating here
          // would cause handleAgentSuccess to re-post the already-answered questions
          // via sendMessages after turn_complete, leaving the agent stuck in
          // "Waiting for user input" forever.
        } else if (evt.type === 'rate_limit') {
          this.pendingTurn.rateLimited = true;
        } else if (evt.type === 'turn_complete') {
          // Flush buffered text before resolving the turn so downstream sees all text.
          this.flushTextBuffer();
          if (this.turnIdleTimer) { clearTimeout(this.turnIdleTimer); this.turnIdleTimer = null; }
          const t = this.pendingTurn;
          this.pendingTurn = null;
          if (evt.error) {
            // Turn-level error (e.g. gateway "400 Unknown mode") — fail the turn so the lifecycle
            // shows ❌ Error and posts the message, matching the Claude adapter's is_error path.
            // Fall through (no continue) so turn_complete is still pushed to this.events and the
            // facade event loop terminates cleanly, exactly like the fatal-error branch below.
            t.reject(new Error(evt.error));
          } else {
            const result: AgentResult = {
              sessionId: this.sessionId,
              total_cost_usd: evt.totalCostUsd,
              num_turns: evt.numTurns,
              rateLimited: t.rateLimited,
              rateLimitMessage: null,
              planFilePath: t.planFilePath,
              enteredPlanMode: false,
              exitedPlanMode: t.planFilePath !== null,
              askUserQuestions: t.askUserQuestions.length > 0 ? t.askUserQuestions : undefined,
              finalOutput: null,
            };
            t.resolve(result);
          }
        } else if (evt.type === 'error' && evt.fatal) {
          this.flushTextBuffer();
          if (this.turnIdleTimer) { clearTimeout(this.turnIdleTimer); this.turnIdleTimer = null; }
          const t = this.pendingTurn;
          this.pendingTurn = null;
          t.reject(new Error(evt.message));
        }
      }

      // Buffer assistant_text deltas until a message boundary (turn_progress from
      // message_end) or a non-text event arrives, then flush as a single event.
      // This matches Claude adapter behavior where onAssistantMessage fires once
      // per complete assistant message block, not per token.
      if (evt.type === 'assistant_text') {
        const blockId = evt.blockId ?? null;
        // A different blockId means the previous block ended without an intervening non-text
        // event; flush it so one assistant_text never mixes text from two blocks.
        if (this.textBuffer.length > 0 && blockId !== this.textBlockId) this.flushTextBuffer();
        this.textBlockId = blockId;
        // Stream the incremental chunk for the live UI preview. Emitted at PI's native
        // per-token granularity — coalescing happens downstream, before the bus. The buffered
        // whole message below stays authoritative (Slack, history, transcript).
        if (this.streamDeltas && blockId !== null) {
          this.events.push({ type: 'assistant_delta', text: evt.text, blockId });
        }
        this.textBuffer += evt.text;
      } else {
        this.flushTextBuffer();
        this.events.push(evt);
      }
    }
  }

  send(msg: UserMessage): void {
    if (!this.alive) throw new Error('PISession.send: subprocess is not alive');
    this.proc.stdin?.write(encodeCommand({ type: 'prompt', message: buildPromptText(msg) }));
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
        this.proc.stdin?.write(encodeCommand({ type: 'prompt', message: promptText }));
        return { switched: false, cancelled: false };
      }
      const result = await this.sendSwitchSession(targetPath);
      if (result.ok) {
        this.currentSessionId = targetSessionId;
      }
      // BLOCKER-1 fix: write prompt in every branch regardless of result.ok.
      // NTH-A: if result.ok===false (pi rejected switch), the prompt goes to the current
      // (un-switched) session — intentional best-effort, caller can inspect result.ok.
      this.proc.stdin?.write(encodeCommand({ type: 'prompt', message: promptText }));
      return { switched: result.ok, cancelled: result.cancelled };
    }

    // Same session: write prompt directly.
    this.proc.stdin?.write(encodeCommand({ type: 'prompt', message: promptText }));
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
      rateLimited: false,
      numTurns: null,
      totalCostUsd: null,
    };
    this.startTurnIdleTimer();
  }

  /** Belt-and-suspenders: reject the pendingTurn if it is still outstanding (i.e., not yet resolved by events). */
  beginTurnReject(err: Error): void {
    if (this.pendingTurn !== null) {
      const t = this.pendingTurn;
      this.pendingTurn = null;
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

export class PIAdapter implements AgentAdapter {
  readonly backend: Backend = 'pi';
  readonly capabilities: Set<Capability> = CAPABILITIES_BY_BACKEND.pi;
  private readonly sessions = new Map<string, PISession>();
  private readonly spawner: SpawnFn;
  private readonly sessionPathRegistry = new Map<string, string>();
  /** sessionDir for the <sessionId>.jsonl path convention. Exposed for tests. */
  readonly sessionDir: string;

  constructor(spawner: SpawnFn = defaultSpawn, sessionDir: string = DEFAULT_SESSION_DIR) {
    this.spawner = spawner;
    this.sessionDir = sessionDir;
  }

  spawn(config: AgentSpawnConfig): PIAgentProcess {
    const sessionDir = this.sessionDir;
    mkdirSync(sessionDir, { recursive: true });

    // Resume: pass the session ID (UUID) directly to --session.  PI scans the
    // --session-dir and matches by filename or internal session `id` field, so we
    // don't need to construct the exact file path (which may differ from the
    // session UUID due to PI's internal session chaining).
    //
    // The sessionPathRegistry is populated below from the bootstrap session_started
    // event for switchSession / sendTurn path lookups — it is NOT used for the
    // --session CLI flag here.
    //
    // Guard (mirrors Claude's resolveResumeForPrint): PI's `--session <id>` can only RESUME an
    // existing session — unlike Claude it cannot create/force a session under an externally-supplied
    // id. If the requested id has no matching session (a fresh session, or a stale backendSessionId
    // whose file was pruned), passing --session makes PI exit with "No session found matching <id>".
    // So only resume when the session is known: either bootstrapped in THIS adapter instance (path
    // registry) or present on disk (a prior process / persisted backendSessionId). Otherwise start
    // fresh and let PI bootstrap its own id (captured back as backendSessionId by the caller).
    const wantResume = !!(config.resume && config.sessionId);
    const sessionKnown =
      wantResume &&
      (this.sessionPathRegistry.has(config.sessionId!) || piSessionFileExists(sessionDir, config.sessionId!));
    const sessionIdForSpawn = sessionKnown ? config.sessionId! : null;
    if (wantResume && sessionIdForSpawn === null) {
      log.info(`PI resume target '${config.sessionId}' not found (no live session or file in ${sessionDir}); starting fresh`);
    }

    const cliArgs = buildSpawnArgs({
      sessionDir,
      sessionId: sessionIdForSpawn,
      model: config.model ?? null,
      provider: config.piProvider ?? null,
      systemPrompt: config.systemPrompt ?? null,
      appendSystemPrompt: config.appendSystemPrompt ?? null,
      pluginDirs: config.pluginDirs ?? null,
      // All three extensions always injected: MCP bridge (task 5754) + tool shims (task 5b5c) + hook bridge (task d3ae).
      extensionPaths: [MCP_BRIDGE_PATH, TOOL_SHIMS_PATH, HOOK_BRIDGE_PATH],
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
        ensureAuthVisible();
      } catch (err) {
        log.warn(`Failed to mirror PI auth.json: ${(err as Error).message}`);
      }
      try {
        // Override set = providers PI reports creds for (discovered) ∪ the provider THIS spawn
        // uses (config.piProvider). The current provider is always routed through the gateway even
        // when discovery doesn't list it (e.g. an anthropic-protocol relay whose key the gateway
        // injects). config.piGatewayPath, when set, decouples the gateway route from the provider name.
        const discovered = discoverPIProviders();
        const overrides = buildProviderOverrides(discovered, config.piProvider ?? null, config.piGatewayPath ?? null);
        if (overrides.length > 0) {
          writeProvidersConfig(overrides, config.piGatewayBaseUrl);
        } else {
          log.warn('No PI providers to route (empty discovery and no profile provider); PI subprocess may fail to authenticate');
        }
      } catch (err) {
        log.warn(`Failed to write PI models.json: ${(err as Error).message}`);
      }
    }

    const env: Record<string, string | undefined> = { ...process.env, ...(config.env ?? {}), PI_CODING_AGENT_DIR: PI_AGENT_DIR };
    if (config.channel) {
      env.SLACK_CHANNEL = config.channel;
      env.FEISHU_CHANNEL = config.channel;
    }
    // Forward the agent's tool allowlist (Claude-native names) so tool-shims.ts can gate which
    // pseudo-tools it registers — mirroring the Claude backend's `--tools` allowlist. Without this,
    // thread-dispatched agents (whose config excludes AskUserQuestion/EnterPlanMode/ExitPlanMode)
    // would still be handed those interaction tools and deadlock on an approval no human can answer.
    const allowedTools = config.rawTools
      ?? (config.tools && config.tools.length > 0
        ? config.tools.map((t) => fromCanonical('claude', t)).filter((n): n is string => !!n).join(',')
        : undefined);
    if (allowedTools) env.CORTEX_PI_ALLOWED_TOOLS = allowedTools;
    const cwd = config.cwd ?? DATA_DIR;

    const session = new PISession({
      sessionKey: config.sessionKey,
      sessionDir,
      cliArgs,
      cwd,
      env,
      spawner: this.spawner,
      registry: this.sessionPathRegistry,
      registrySessionDir: sessionDir,
      onClose: (key) => this.sessions.delete(key),
    });
    this.sessions.set(config.sessionKey, session);

    return {
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
            const targetPath = this.sessionPathRegistry.get(targetId) ?? null;
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
      sendExtensionUiResponse: (id: string, payload: Record<string, unknown>): void => {
        session.sendExtensionUiResponse(id, payload);
      },
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

  /**
   * Resolve the JSONL file path for a given PI session ID.
   * Returns null if the session has not been registered yet (not spawned or bootstrap pending).
   */
  resolveSessionPath(sessionId: string): string | null {
    return this.sessionPathRegistry.get(sessionId) ?? null;
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

export const _test = {
  buildSpawnArgs,
  encodeCommand,
  createLineSplitter,
  DEFAULT_SESSION_DIR,
  MCP_BRIDGE_PATH,
  TOOL_SHIMS_PATH,
  HOOK_BRIDGE_PATH,
  CLOSE_EXIT_WAIT_MS,
  SWITCH_SESSION_TIMEOUT_MS,
};
