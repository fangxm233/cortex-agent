// input:  session context, Codex RPC, auth, MCP sidecars
// output: CodexAdapter lifecycle, turns, and configuration
// pos:    Codex app-server backend adapter
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { createWriteStream, writeFileSync, readFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import type { WriteStream } from 'fs';
import { createInterface } from 'readline';
import type { Interface as ReadlineInterface } from 'readline';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { moduleDir, readableTimestamp, DATA_DIR, WORKSPACE_DIR, INSTALL_ROOT } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { summarizeRateLimits, parseRateLimitsFromRawLog } from '@domain/costs/rate-limit-parser.js';
import { CODEX_LOG_MODE, shouldLogCodexEvent, formatCodexEvent, type CodexEventParams } from '@domain/costs/codex-event-format.js';
import type { AgentResult, AgentHandle } from '@core/types/agent-types.js';
import type { AgentAdapter, AgentSpawnConfig, AgentProcess, Backend, UserMessage } from '../types.js';
import { Capability, CAPABILITIES_BY_BACKEND } from '../capabilities.js';
import type { NormalizedEvent } from '../normalize/event-types.js';
import { createEventStream } from '../normalize/event-stream.js';
import { codexEventToNormalized } from './event-parser.js';
import { buildCodexSystemPrompt } from './spawn-args.js';

const log = createLogger('codex-adapter');

const MODULE_DIR = moduleDir(import.meta.url);
const LOGS_DIR = path.join(DATA_DIR, 'logs', 'sessions');
mkdirSync(LOGS_DIR, { recursive: true });

const MAX_TIMEOUT = 30_000_000; // ~8.3 hours
const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes with no output on a turn
const GLOBAL_CODEX_DIR = path.join(os.homedir(), '.codex');
const GLOBAL_CODEX_CONFIG_PATH = path.join(GLOBAL_CODEX_DIR, 'config.toml');
const GLOBAL_CODEX_AUTH_PATH = path.join(GLOBAL_CODEX_DIR, 'auth.json');
const ROUTE_RUNTIME_ROOT = path.join(WORKSPACE_DIR, 'codex-routes');
const ROUTE_IDLE_TIMEOUT_MS = Number(process.env.CODEX_ROUTE_IDLE_TIMEOUT_MS || 20 * 60 * 1000);
mkdirSync(ROUTE_RUNTIME_ROOT, { recursive: true });

class CancelledError extends Error {
  cancelled: boolean;
  constructor() { super('Cancelled by user'); this.cancelled = true; }
}

// --- Token → USD cost estimation via aistatus.cc ---

import { CostCalculator } from 'aistatus';

const codexCostCalculator = new CostCalculator();

function estimateCost(usage: Record<string, unknown>, authMode: string): number {
  // ChatGPT plan usage is included in subscription — no API cost
  if (authMode === 'chatgpt') return 0;

  const model = process.env.CODEX_MODEL || 'o4-mini';
  const inputTokens = Number(usage.inputTokens || usage.promptTokens || 0);
  const outputTokens = Number(usage.outputTokens || usage.completionTokens || 0);
  return codexCostCalculator.calculateCost('openai', model, inputTokens, outputTokens);
}

// --- Auth detection ---

/**
 * Determine auth mode: default to ChatGPT plan when both are available.
 * CODEX_AUTH_MODE env var can force a specific mode.
 */
function detectAuthMode(): string | null {
  const forced = process.env.CODEX_AUTH_MODE;
  if (forced === 'apiKey' || forced === 'chatgpt') return forced;

  try {
    const auth = JSON.parse(readFileSync(GLOBAL_CODEX_AUTH_PATH, 'utf8'));
    if (auth.auth_mode === 'chatgpt' && auth.tokens?.access_token) return 'chatgpt';
  } catch {}

  if (process.env.OPENAI_API_KEY) return 'apiKey';

  return null; // no auth available
}

function readCodexAuth(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(GLOBAL_CODEX_AUTH_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function closeStream(stream: WriteStream | null): Promise<void> {
  if (!stream) return Promise.resolve();
  return new Promise<void>((resolve) => stream.end(resolve));
}

// --- Per-route runtime config ---

const CORTEX_MCP_SECTION_HEADERS = new Set(
  ['cortex', 'cortex-core', 'cortex-tasks', 'cortex-thread', 'cortex-ext']
    .flatMap((name) => [`[mcp_servers.${name}]`, `[mcp_servers.${name}.env]`]),
);

function stripCortexMcpSections(tomlText: string): string {
  const filtered = [];
  let inCortexSection = false;
  for (const line of tomlText.split('\n')) {
    const trimmed = line.trim();
    if (CORTEX_MCP_SECTION_HEADERS.has(trimmed)) {
      inCortexSection = true;
      continue;
    }
    if (inCortexSection && trimmed.startsWith('[')) inCortexSection = false;
    if (!inCortexSection) filtered.push(line);
  }
  return filtered.join('\n').trimEnd();
}

/** Cortex agent execution context — surfaces both in route-context.json (for the
 *  slack/context MCP tools to read at request time) and as CORTEX_* env vars in
 *  the MCP server child. Mirrors CortexAgentContext in claude/spawn-args.ts. */
interface CortexAgentContext {
  threadId?: string | null;
  profile?: string | null;
  project?: string | null;
  sessionName?: string | null;
  /** Stable Cortex tracking id (decoupled from the backend session id) → CORTEX_SESSION_ID. */
  trackSessionId?: string | null;
  /** Cortex execution record id, surfaced as CORTEX_EXECUTION_ID to subprocess env. */
  executionId?: string | null;
}

function writeRouteContext(routeContextPath: string, { channel, callbackSource, sessionId, context }: { channel: string; callbackSource: string | null; sessionId: string | null; context?: CortexAgentContext }): void {
  writeFileSync(routeContextPath, JSON.stringify({
    channel,
    callbackSource: callbackSource || null,
    sessionId: sessionId || null,
    threadId: context?.threadId || null,
    profile: context?.profile || null,
    project: context?.project || null,
    sessionName: context?.sessionName || null,
    updatedAt: new Date().toISOString(),
  }));
}

function ensureCodexConfig({ runtimeHome, channel, callbackSource = null, sessionId = null, routeContextPath, context }: { runtimeHome: string; channel: string; callbackSource?: string | null; sessionId?: string | null; routeContextPath: string; context?: CortexAgentContext }): void {
  const runtimeCodexDir = path.join(runtimeHome, '.codex');
  mkdirSync(runtimeCodexDir, { recursive: true });

  try {
    const runtimeAuthPath = path.join(runtimeCodexDir, 'auth.json');
    if (!existsSync(runtimeAuthPath) && existsSync(GLOBAL_CODEX_AUTH_PATH)) copyFileSync(GLOBAL_CODEX_AUTH_PATH, runtimeAuthPath);
  } catch {}

  let base = '';
  try { base = stripCortexMcpSections(readFileSync(GLOBAL_CODEX_CONFIG_PATH, 'utf8')); } catch {}

  writeRouteContext(routeContextPath, { channel, callbackSource, sessionId, context });
  writeFileSync(path.join(runtimeCodexDir, 'config.toml'), base + '\n' + buildMcpBlock(channel, sessionId, callbackSource, routeContextPath, context));
}

function buildMcpBlock(channel: string, sessionId: string | null, callbackSource: string | null, routeContextPath: string, context?: CortexAgentContext): string {
  // Point at compiled .js MCP servers so the installed package (which only ships dist/+defaults/)
  // can locate them. The tsx loader is no longer needed for plain JS.
  const coreServerPath = path.join(INSTALL_ROOT, 'dist', 'domain', 'mcp', 'core-server.js');
  const tasksServerPath = path.join(INSTALL_ROOT, 'dist', 'domain', 'mcp', 'tasks-server.js');
  const threadServerPath = path.join(INSTALL_ROOT, 'dist', 'domain', 'mcp', 'thread-server.js');
  const extServerPath = path.join(INSTALL_ROOT, 'dist', 'domain', 'mcp', 'server.js');
  const escapedPath = (p: string) => p.replace(/\\/g, '/');

  // CORTEX_SESSION_ID = stable Cortex tracking id (falls back to the backend id when unset).
  const baseEnv: Record<string, string> = { CORTEX_SESSION_ID: context?.trackSessionId ?? sessionId ?? '', CORTEX_BACKEND: 'codex', CORTEX_ROUTE_CONTEXT_FILE: routeContextPath };
  if (callbackSource) baseEnv.CORTEX_CALLBACK_SOURCE = callbackSource;
  if (context?.threadId) baseEnv.CORTEX_THREAD_ID = context.threadId;
  if (context?.profile) baseEnv.CORTEX_PROFILE = context.profile;
  if (context?.project) baseEnv.CORTEX_PROJECT = context.project;
  if (context?.sessionName) baseEnv.CORTEX_SESSION_NAME = context.sessionName;
  if (context?.executionId) baseEnv.CORTEX_EXECUTION_ID = context.executionId;
  const formatEnv = (extra: Record<string, string>) =>
    Object.entries({ ...baseEnv, ...extra })
      .map(([k, v]) => `${k} = "${String(v).replace(/"/g, '\\"')}"`)
      .join('\n');

  const section = (name: string, serverPath: string, extraEnv: Record<string, string> = {}) => {
    return `\n[mcp_servers.${name}]\ncommand = "node"\nargs = ["${escapedPath(serverPath)}", "--route-context-file", "${escapedPath(routeContextPath)}"]\n\n[mcp_servers.${name}.env]\n${formatEnv(extraEnv)}\n`;
  };
  const alwaysOn = section('cortex-core', coreServerPath)
    + section('cortex-tasks', tasksServerPath);

  if (context?.threadId) {
    return alwaysOn + section('cortex-thread', threadServerPath);
  }

  return alwaysOn + section('cortex-ext', extServerPath, {
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || '',
    SLACK_CHANNEL: channel || '',
    FEISHU_CHANNEL: channel || '',
  });
}

// ============================================================
// CodexAppServer — manages a long-lived codex app-server process
// ============================================================

class CodexAppServer {
  routeKey: string;
  channel: string;
  callbackSource: string | null;
  runtimeHome: string;
  routeContextPath: string;
  proc: ChildProcess | null;
  rl: ReadlineInterface | null;
  requestId: number;
  pendingRequests: Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer?: ReturnType<typeof setTimeout> }>;
  eventListeners: Map<string, (method: string, params: CodexEventParams) => void>;
  _stderr: string;
  _authMode: string | null;
  /** Most recent CortexAgentContext snapshot (refreshed via updateContext per turn).
   *  Persisted to route-context.json on each refresh so the MCP server can read live values. */
  _context: CortexAgentContext | undefined;

  constructor({ routeKey, channel, callbackSource = null }: { routeKey: string; channel: string; callbackSource?: string | null }) {
    this.routeKey = routeKey;
    this.channel = channel;
    this.callbackSource = callbackSource;
    const routeHash = crypto.createHash('sha1').update(routeKey).digest('hex').slice(0, 12);
    this.runtimeHome = path.join(ROUTE_RUNTIME_ROOT, routeHash);
    this.routeContextPath = path.join(this.runtimeHome, '.codex', 'route-context.json');

    this.proc = null;
    this.rl = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.eventListeners = new Map();
    this._stderr = '';
    this._authMode = null;
    this._context = undefined;
  }

  // --- Process lifecycle ---

  /** Refresh the CortexAgentContext snapshot used for subsequent route-context.json writes.
   *  Caller invokes this per turn, before send(), so the MCP server's cortex_context tool
   *  sees the live thread/profile/project/session-name for the current turn. */
  updateContext(context: CortexAgentContext | undefined): void {
    this._context = context;
  }

  updateRouteContext(sessionId: string): void {
    writeRouteContext(this.routeContextPath, {
      channel: this.channel,
      callbackSource: this.callbackSource,
      sessionId,
      context: this._context,
    });
  }

  async start(sessionId: string): Promise<void> {
    if (this.isRunning()) return;
    ensureCodexConfig({ runtimeHome: this.runtimeHome, channel: this.channel, callbackSource: this.callbackSource, sessionId, routeContextPath: this.routeContextPath, context: this._context });

    const authMode = detectAuthMode();
    if (!authMode) throw new Error('No Codex auth available — set OPENAI_API_KEY or run `codex login`');
    this._authMode = authMode;

    this._spawnProcess();
    await this._initialize();
    await this._login();
    log.info(`[codex-server:${this.routeKey}] Ready (auth=${authMode})`);
  }

  _spawnProcess(): void {
    const env = { ...process.env, HOME: this.runtimeHome, CORTEX_BACKEND: 'codex', CORTEX_ROUTE_CONTEXT_FILE: this.routeContextPath };
    this.proc = spawn('codex', ['app-server', '-c', 'history.persistence="none"'], { cwd: DATA_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this._stderr = '';
    this.proc.stderr!.on('data', (d: Buffer) => {
      this._stderr = (this._stderr + d.toString()).slice(-2000);
      log.info(`[codex-server:${this.routeKey}] stderr:`, d.toString().trim());
    });
    this.proc.on('close', (code: number | null) => {
      this.proc = null;
      for (const [, req] of this.pendingRequests) { clearTimeout(req.timer); req.reject(new Error(`Codex process exited (code ${code})`)); }
      this.pendingRequests.clear();
      this.eventListeners.clear();
    });
    this.rl = createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    this.rl.on('line', (line) => this._onLine(line));
  }

  stop(): void {
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
    }
    this.proc = null;
  }

  isRunning(): boolean {
    return this.proc != null && this.proc.exitCode === null;
  }

  // --- JSON-RPC transport ---

  _write(obj: Record<string, unknown>): void {
    if (!this.isRunning()) throw new Error('Codex app-server not running');
    this.proc!.stdin!.write(JSON.stringify(obj) + '\n');
  }

  _sendRequest(method: string, params: Record<string, unknown> = {}, timeout: number = 120_000): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for response: ${method} (id=${id})`));
      }, timeout);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this._write({ method, id, params });
    });
  }

  _sendNotification(method: string, params: Record<string, unknown> = {}): void {
    this._write({ method, params });
  }

  _sendResponse(id: number, result: unknown): void {
    this._write({ id, result });
  }

  _sendErrorResponse(id: number, code: number, message: string): void {
    this._write({ id, error: { code, message } });
  }

  _resolvePendingResponse(msg: { id: number; result?: unknown; error?: { code: number; message: string } }): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.id);
    if (msg.error) pending.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
    else pending.resolve(msg.result);
  }

  _onLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: number; method?: string; params?: CodexEventParams; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      log.info(`[codex-server:${this.routeKey}] Non-JSON line:`, line.substring(0, 200));
      return;
    }
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      this._resolvePendingResponse(msg as { id: number; result?: unknown; error?: { code: number; message: string } });
      return;
    }
    if (msg.id != null && msg.method) {
      this._handleServerRequest(msg as { id: number; method: string; params?: CodexEventParams });
      return;
    }
    if (msg.method && msg.id == null) {
      this._dispatchEvent(msg.method, msg.params || {});
    }
  }

  _handleServerRequest(msg: { id: number; method: string; params?: CodexEventParams }): void {
    const { method, id, params } = msg;

    // Auto-approve all operations (equivalent to --full-auto)
    if (method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval') {
      log.info(`[codex-server:${this.routeKey}] Auto-approving: ${method} (id=${id})`);
      this._sendResponse(id, 'accept');
      return;
    }

    // Token refresh — use refresh_token to get new access token
    if (method === 'account/chatgptAuthTokens/refresh') {
      log.info(`[codex-server:${this.routeKey}] Token refresh requested, reason:`, params?.reason);
      this._refreshChatgptTokens(id).catch(err => {
        log.error(`[codex-server:${this.routeKey}] Token refresh failed:`, err.message);
        this._sendErrorResponse(id, -32601, `Token refresh failed: ${err.message}`);
      });
      return;
    }

    // tool/requestUserInput — provide empty responses
    if (method === 'tool/requestUserInput') {
      log.info(`[codex-server:${this.routeKey}] Auto-responding to user input request`);
      this._sendResponse(id, { answers: [] });
      return;
    }

    log.info(`[codex-server:${this.routeKey}] Unhandled server request: ${method} (id=${id})`);
    this._sendErrorResponse(id, -32601, `Not handled: ${method}`);
  }

  _dispatchEvent(method: string, params: CodexEventParams): void {
    for (const [, listener] of this.eventListeners) {
      try { listener(method, params); } catch (e) {
        log.error(`[codex-server:${this.routeKey}] Event listener error:`, (e as Error).message);
      }
    }
  }

  // --- Token refresh ---

  async _fetchRefreshedTokens(refreshToken: string): Promise<Record<string, unknown>> {
    const resp = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`OAuth refresh failed (${resp.status}): ${body.substring(0, 200)}`);
    }
    return resp.json();
  }

  async _refreshChatgptTokens(requestId: number): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- auth.json is deeply nested untyped JSON
    const auth = readCodexAuth() as any;
    if (!auth?.tokens?.refresh_token) throw new Error('No refresh_token in auth.json');

    const data = await this._fetchRefreshedTokens(auth.tokens.refresh_token);
    log.info('Token refreshed successfully');
    auth.tokens.access_token = data.access_token;
    if (data.id_token) auth.tokens.id_token = data.id_token;
    if (data.refresh_token) auth.tokens.refresh_token = data.refresh_token;
    auth.last_refresh = new Date().toISOString();
    writeFileSync(GLOBAL_CODEX_AUTH_PATH, JSON.stringify(auth, null, 2));

    this._sendResponse(requestId, {
      accessToken: data.access_token,
      chatgptAccountId: auth.tokens.account_id,
      chatgptPlanType: null,
    });
  }

  // --- Protocol methods ---

  async _initialize(): Promise<unknown> {
    const result = await this._sendRequest('initialize', {
      clientInfo: { name: 'cortex', title: 'Cortex Agent', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    }, 30_000);
    this._sendNotification('initialized', {});
    log.info(`[codex-server:${this.routeKey}] Initialized:`, (result as Record<string, unknown>)?.userAgent || 'unknown');
    return result;
  }

  async _login(): Promise<void> {
    if (this._authMode === 'apiKey') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OPENAI_API_KEY not set');
      await this._sendRequest('account/login/start', {
        type: 'apiKey',
        apiKey,
      }, 30_000);
      log.info(`[codex-server:${this.routeKey}] Logged in with API key`);
    } else {
      // ChatGPT plan — pass cached tokens from ~/.codex/auth.json
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- auth.json is deeply nested untyped JSON
      const auth = readCodexAuth() as any;
      if (!auth?.tokens?.access_token || !auth?.tokens?.account_id) {
        throw new Error('No ChatGPT tokens in ~/.codex/auth.json — run `codex login`');
      }
      await this._sendRequest('account/login/start', {
        type: 'chatgptAuthTokens',
        accessToken: auth.tokens.access_token,
        chatgptAccountId: auth.tokens.account_id,
      }, 30_000);
      log.info(`[codex-server:${this.routeKey}] Logged in with ChatGPT plan`);
    }
  }

  async startThread(cwd: string): Promise<Record<string, unknown>> {
    const params: Record<string, string> = {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    };
    // Only override model if explicitly set; otherwise use ~/.codex/config.toml
    if (process.env.CODEX_MODEL) params.model = process.env.CODEX_MODEL;
    const result = await this._sendRequest('thread/start', params, 30_000) as Record<string, Record<string, unknown>>;
    log.info(`[codex-server:${this.routeKey}] Thread started:`, result?.thread?.id);
    return result.thread;
  }

  async resumeThread(threadId: string): Promise<Record<string, unknown>> {
    const params: Record<string, string> = { threadId };
    if (process.env.CODEX_MODEL) params.model = process.env.CODEX_MODEL;
    const result = await this._sendRequest('thread/resume', params, 30_000) as Record<string, unknown>;
    log.info(`[codex-server:${this.routeKey}] Thread resumed:`, threadId);
    return (result.thread || result) as Record<string, unknown>;
  }

  /**
   * Send a turn and wait for completion.
   * Returns { turn, tokenUsage, itemCount }.
   */
  sendTurn(threadId: string, input: unknown[], { cwd, onEvent, timeout = MAX_TIMEOUT }: { cwd?: string; onEvent?: (method: string, params: CodexEventParams) => void; timeout?: number } = {}): Promise<{ turn: CodexEventParams; tokenUsage: Record<string, unknown> | null; itemCount: number }> {
    return new Promise((resolve, reject) => {
      let tokenUsage: Record<string, unknown> | null = null;
      let itemCount = 0;
      let settled = false;

      const listenerKey = `turn-${Date.now()}-${Math.random()}`;

      const idleTimer: { ref: ReturnType<typeof setTimeout> | null } = { ref: null };
      const maxTimer = setTimeout(() => {
        cleanup();
        reject(new Error('Turn max timeout'));
      }, timeout);

      function resetIdle(): void {
        if (idleTimer.ref) clearTimeout(idleTimer.ref);
        idleTimer.ref = setTimeout(() => {
          cleanup();
          reject(new Error(`Turn idle timeout (${IDLE_TIMEOUT / 1000}s no events)`));
        }, IDLE_TIMEOUT);
      }

      const cleanup = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(maxTimer);
        if (idleTimer.ref) clearTimeout(idleTimer.ref);
        this.eventListeners.delete(listenerKey);
      };

      resetIdle();

      this.eventListeners.set(listenerKey, (method: string, params: CodexEventParams) => {
        if (settled) return;
        resetIdle();

        if (onEvent) onEvent(method, params);

        if (method === 'thread/tokenUsage/updated') {
          tokenUsage = params.tokenUsage?.total;
        }
        if (method === 'item/completed') {
          itemCount++;
        }
        if (method === 'turn/completed') {
          cleanup();
          resolve({ turn: params.turn, tokenUsage, itemCount });
        }
      });

      // Fire turn/start
      this._sendRequest('turn/start', {
        threadId,
        input,
        cwd: cwd || DATA_DIR,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      }, 60_000).catch((err: Error) => {
        cleanup();
        reject(err);
      });
    });
  }

  async interruptTurn(threadId: string, turnId: string | null): Promise<boolean> {
    const params: Record<string, string> = { threadId };
    if (typeof turnId === 'string' && turnId.length > 0) {
      params.turnId = turnId;
    }
    try {
      await this._sendRequest('turn/interrupt', params, 10_000);
      return true;
    } catch (e) {
      log.info(`[codex-server:${this.routeKey}] Interrupt failed:`, (e as Error).message);
      return false;
    }
  }
}

// ============================================================
// Route runtime pool (parallel across routes, serialized per route)
// ============================================================

class RouteRuntime {
  routeKey: string;
  channel: string;
  callbackSource: string | null;
  server: CodexAppServer;
  queueTail: Promise<unknown>;
  activeTurns: number;
  idleTimer: ReturnType<typeof setTimeout> | null;

  constructor({ routeKey, channel, callbackSource = null }: { routeKey: string; channel: string; callbackSource?: string | null }) {
    this.routeKey = routeKey;
    this.channel = channel;
    this.callbackSource = callbackSource;
    this.server = new CodexAppServer({ routeKey, channel, callbackSource });

    this.queueTail = Promise.resolve();
    this.activeTurns = 0;
    this.idleTimer = null;
  }

  enqueue<T>(taskFn: (server: CodexAppServer) => Promise<T>): Promise<T> {
    this._clearIdleTimer();
    const run = async (): Promise<T> => {
      this.activeTurns++;
      try {
        return await taskFn(this.server);
      } finally {
        this.activeTurns--;
        this._armIdleTimer();
      }
    };
    const p = this.queueTail.then(run, run);
    this.queueTail = p.catch(() => {});
    return p;
  }

  stop(): void {
    this._clearIdleTimer();
    this.server.stop();
  }

  _clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _armIdleTimer(): void {
    this._clearIdleTimer();
    if (!(ROUTE_IDLE_TIMEOUT_MS > 0) || this.activeTurns > 0) return;

    this.idleTimer = setTimeout(() => {
      if (this.activeTurns > 0) return;
      const current = routeRuntimePool.get(this.routeKey);
      if (current !== this) return;
      log.info(`[codex-route] Idle timeout (${Math.round(ROUTE_IDLE_TIMEOUT_MS / 1000)}s): ${this.routeKey}`);
      this.stop();
      routeRuntimePool.delete(this.routeKey);
    }, ROUTE_IDLE_TIMEOUT_MS);
  }
}

const routeRuntimePool: Map<string, RouteRuntime> = new Map();

function buildRouteKey(channel: string, callbackSource: string | null): string {
  return `${channel || ''}|${callbackSource || ''}`;
}

function getRouteRuntime(channel: string, callbackSource: string | null): RouteRuntime {
  const routeKey = buildRouteKey(channel, callbackSource);
  let runtime = routeRuntimePool.get(routeKey);
  if (!runtime) {
    runtime = new RouteRuntime({ routeKey, channel, callbackSource });
    routeRuntimePool.set(routeKey, runtime);
    log.info(`[codex-route] Created runtime: ${routeKey}`);
  }
  return runtime;
}

function shutdownCodex(): void {
  for (const runtime of routeRuntimePool.values()) {
    runtime.stop();
  }
  routeRuntimePool.clear();
}

// ============================================================
// runCodex() — drop-in replacement for runClaude()
// ============================================================

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

interface SlackFile {
  mimetype: string;
  localPath: string;
  name: string;
}

function buildTurnInput(userMessage: string, files: SlackFile[], systemPrompt?: string): Array<{ type: string; text?: string; path?: string }> {
  const input: Array<{ type: string; text?: string; path?: string }> = [];
  if (systemPrompt) {
    input.push({ type: 'text', text: systemPrompt });
  }
  if (files.length > 0) {
    const imageFiles = files.filter((f: SlackFile) => IMAGE_MIMES.has(f.mimetype));
    const otherFiles = files.filter((f: SlackFile) => !IMAGE_MIMES.has(f.mimetype));
    for (const f of imageFiles) {
      input.push({ type: 'localImage', path: f.localPath.replace(/\\/g, '/') });
    }
    if (otherFiles.length > 0) {
      const fileList = otherFiles.map((f: SlackFile) => `${f.localPath.replace(/\\/g, '/')} (${f.name})`).join('\n');
      input.push({ type: 'text', text: `[User sent ${otherFiles.length} file(s). Read these files:\n${fileList}\n]` });
    }
  }
  input.push({ type: 'text', text: userMessage || 'Please analyze the attached file(s).' });
  return input;
}

function openCodexLogs(channel: string, threadId: string): { rawLogPath: string; rawStream: WriteStream | null; txtStream: WriteStream | null; writeDetailedLogs: boolean } {
  const ts = readableTimestamp();
  const rawLogPath = path.join(LOGS_DIR, `codex-output-${ts}.jsonl`);
  const txtLogPath = path.join(LOGS_DIR, `codex-output-${ts}.txt`);
  const writeDetailedLogs = CODEX_LOG_MODE !== 'off';
  const rawStream = writeDetailedLogs ? createWriteStream(rawLogPath, { flags: 'a' }) : null;
  const txtStream = writeDetailedLogs ? createWriteStream(txtLogPath, { flags: 'a' }) : null;
  if (txtStream) {
    txtStream.write(`=== Codex turn started at ${new Date().toISOString()} ===\n`);
    txtStream.write(`=== channel=${channel}, thread=${threadId}, log_mode=${CODEX_LOG_MODE} ===\n\n`);
  }
  return { rawLogPath, rawStream, txtStream, writeDetailedLogs };
}

/** If the last assistant message is a brief epilogue but there was a much longer earlier
 *  message, merge them so Slack gets the real content.
 *  Triggers only when final is both absolutely short (<300) AND relatively short (<50% of longest). */
function mergeSubstantialOutput(finalOutput: string | null, longestOutput: string | null): string | null {
  if (!finalOutput || !longestOutput) return finalOutput;
  if (finalOutput === longestOutput) return finalOutput;
  if (finalOutput.length < 300 && finalOutput.length < longestOutput.length * 0.5) {
    return longestOutput + '\n\n---\n' + finalOutput;
  }
  return finalOutput;
}

function buildCodexResult({ threadId, turn, tokenUsage, itemCount, authMode, rawLogPath, writeDetailedLogs, liveRateLimitsById, finalOutput, longestOutput }: { threadId: string; turn: CodexEventParams; tokenUsage: Record<string, unknown> | null; itemCount: number; authMode: string; rawLogPath: string; writeDetailedLogs: boolean; liveRateLimitsById: Map<string, unknown>; finalOutput: string | null; longestOutput: string | null }): AgentResult {
  const total_cost_usd = tokenUsage ? estimateCost(tokenUsage, authMode) : null;
  const rateLimited = turn.status === 'failed' &&
    (turn.error?.codexErrorInfo === 'UsageLimitExceeded' ||
     turn.error?.message?.toLowerCase().includes('rate limit'));
  const parsedRateLimits = writeDetailedLogs ? parseRateLimitsFromRawLog(rawLogPath) : summarizeRateLimits([], 'log');
  const eventRateLimits = summarizeRateLimits(Array.from(liveRateLimitsById.values()), 'event');
  const codexRateLimits = parsedRateLimits.limits.length > 0 ? parsedRateLimits : eventRateLimits;

  return {
    sessionId: threadId, total_cost_usd, num_turns: itemCount || 1,
    rateLimited, rateLimitMessage: rateLimited ? turn.error?.message : null,
    codexRateLimits, codexRawLogPath: writeDetailedLogs ? rawLogPath : null,
    finalOutput: mergeSubstantialOutput(finalOutput, longestOutput) || null,
    planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
  };
}

async function resolveThread(server: CodexAppServer, sessionId: string | null): Promise<Record<string, unknown>> {
  if (sessionId) {
    try {
      return await server.resumeThread(sessionId);
    } catch (e) {
      log.info('Resume failed, starting new:', (e as Error).message);
      return await server.startThread(DATA_DIR);
    }
  }
  return await server.startThread(DATA_DIR);
}

interface RunCodexOptions {
  channel: string;
  sessionId: string | null;
  files?: SlackFile[];
  callbackSource?: string | null;
  /** Pre-scanned CORTEX.md system prompt, injected as the first turn input item. */
  cortexMdPrompt?: string;
  /** Per-turn Cortex execution context — refreshed on the shared CodexAppServer so route-context.json reflects the live turn. */
  context?: CortexAgentContext;
  /** Internal: optional NormalizedEvent emitter shared with CodexAdapter.spawn. Not part of the public surface. */
  _onNormalizedEvent?: (event: NormalizedEvent) => void;
  /** Internal: notify caller of the resolved threadId as soon as `resolveThread` returns, so CodexAdapterSession can synthesize `session_started` mid-turn. */
  _onThreadIdResolved?: (threadId: string) => void;
}

function runCodexInternal(userMessage: string, opts: RunCodexOptions): AgentHandle {
  const { channel, sessionId, files = [], callbackSource = null, cortexMdPrompt, context, _onNormalizedEvent, _onThreadIdResolved } = opts;
  let killed = false;
  let currentThreadId: string | null = null;
  let currentTurnId: string | null = null;
  const runtime = getRouteRuntime(channel, callbackSource);

  const promise = runtime.enqueue(async (server: CodexAppServer): Promise<AgentResult> => {
    if (killed) throw new CancelledError();
    server.updateContext(context);
    await server.start(sessionId || crypto.randomUUID());
    if (killed) throw new CancelledError();

    const thread = await resolveThread(server, sessionId);
    currentThreadId = thread.id as string;
    server.updateRouteContext(currentThreadId);
    log.info('Thread:', currentThreadId, sessionId ? '(resumed)' : '(new)');
    if (_onThreadIdResolved) {
      try { _onThreadIdResolved(currentThreadId); } catch (e) { log.error('_onThreadIdResolved error:', (e as Error).message); }
    }

    const input = buildTurnInput(userMessage, files, cortexMdPrompt);
    const { rawLogPath, rawStream, txtStream, writeDetailedLogs } = openCodexLogs(channel, currentThreadId);
    const liveRateLimitsById: Map<string, unknown> = new Map();
    let finalOutput: string | null = null;
    let longestOutput: string | null = null;

    try {
      let progressTurnCount = 0;
      const { turn, tokenUsage, itemCount } = await server.sendTurn(currentThreadId, input, {
        cwd: DATA_DIR,
        onEvent: (method: string, params: CodexEventParams) => {
          if (method === 'turn/started') currentTurnId = params?.turn?.id || currentTurnId;
          else if (method === 'turn/completed') currentTurnId = null;
          else if (method === 'account/rateLimits/updated' && params?.rateLimits?.limitId) liveRateLimitsById.set(params.rateLimits.limitId, params.rateLimits);
          else if (method === 'item/completed' && params?.item?.type === 'agentMessage') {
            const text = String(params.item.text || '').trim();
            if (text) {
              finalOutput = text;
              if (text.length > (longestOutput?.length || 0)) longestOutput = text;
            }
            progressTurnCount++;
            if (_onNormalizedEvent) {
              try { _onNormalizedEvent({ type: 'turn_progress', numTurns: progressTurnCount }); }
              catch (e) { log.error('_onNormalizedEvent error:', (e as Error).message); }
            }
          }
          if (rawStream && (shouldLogCodexEvent(method) || method === 'account/rateLimits/updated')) rawStream.write(JSON.stringify({ method, params, timestamp: new Date().toISOString() }) + '\n');
          const formatted = formatCodexEvent(method, params);
          if (formatted && txtStream) { txtStream.write(formatted + '\n'); log.info(formatted.substring(0, 200)); }
          if (_onNormalizedEvent) {
            const normalized = codexEventToNormalized(method, params);
            if (normalized) {
              try { _onNormalizedEvent(normalized); } catch (e) { log.error('_onNormalizedEvent error:', (e as Error).message); }
            }
          }
        },
      });

      if (txtStream) txtStream.write(`\n=== Turn completed at ${new Date().toISOString()} ===\n`);
      await Promise.all([closeStream(rawStream), closeStream(txtStream)]);
      if (writeDetailedLogs) log.info(`Logs saved (${CODEX_LOG_MODE}):`, rawLogPath);
      currentTurnId = null;

      const result = buildCodexResult({ threadId: currentThreadId, turn, tokenUsage, itemCount, authMode: server._authMode || 'apiKey', rawLogPath, writeDetailedLogs, liveRateLimitsById, finalOutput, longestOutput });
      // Emit cost_record from Codex token usage (available in this scope)
      if (_onNormalizedEvent && result.total_cost_usd != null) {
        const model = process.env.CODEX_MODEL || 'o4-mini';
        _onNormalizedEvent({
          type: 'cost_record',
          provider: 'openai',
          model,
          tokens_in: Number(tokenUsage?.inputTokens || tokenUsage?.promptTokens || 0),
          tokens_out: Number(tokenUsage?.outputTokens || tokenUsage?.completionTokens || 0),
          cost_usd: result.total_cost_usd,
        });
      }
      return result;
    } catch (err) {
      if (txtStream) { txtStream.write(`\n[ERROR] ${(err as Error).message}\n`); txtStream.write(`=== Turn failed at ${new Date().toISOString()} ===\n`); }
      await Promise.all([closeStream(rawStream), closeStream(txtStream)]);
      currentTurnId = null;
      throw err;
    }
  }).catch((err: Error) => { if (killed) throw new CancelledError(); throw err; });

  return {
    promise,
    kill() {
      if (killed) return false;
      killed = true;
      if (currentThreadId && runtime.server.isRunning()) {
        runtime.server.interruptTurn(currentThreadId, currentTurnId).then((ok) => {
          if (!ok && runtime.server.isRunning()) { runtime.stop(); routeRuntimePool.delete(runtime.routeKey); }
        }).catch(() => { runtime.stop(); routeRuntimePool.delete(runtime.routeKey); });
      }
      return true;
    },
  };
}

function runCodex(userMessage: string, { channel, sessionId, files = [], callbackSource = null, context }: { channel: string; sessionId: string | null; files?: SlackFile[]; callbackSource?: string | null; context?: CortexAgentContext }): AgentHandle {
  return runCodexInternal(userMessage, { channel, sessionId, files, callbackSource, context });
}

// ============================================================
// CodexAdapter — DR-0008 §3.2 AgentAdapter implementation
// ============================================================

class CodexAdapterSession implements AgentProcess {
  readonly sessionKey: string;
  sessionId: string | null;
  events: AsyncIterable<NormalizedEvent>;

  private readonly _channel: string;
  private readonly _callbackSource: string | null;
  private readonly _context: CortexAgentContext | undefined;
  private readonly _cortexMdPrompt: string;
  private readonly _push: (e: NormalizedEvent) => void;
  private readonly _closeStream: () => void;
  private readonly _onClosed: () => void;
  private _activeHandle: AgentHandle | null = null;
  private _closed = false;

  constructor(config: AgentSpawnConfig, onClosed: () => void) {
    this.sessionKey = config.sessionKey;
    this.sessionId = config.sessionId;
    // task f7cf: typed config.channel / callbackSource preferred; env fallbacks kept for backward
    // compat with callers that still pass these through env.
    this._channel = config.channel ?? config.env?.CORTEX_CHANNEL ?? config.sessionKey;
    this._callbackSource = config.callbackSource ?? config.env?.CORTEX_CALLBACK_SOURCE ?? null;
    this._context = config.cortexContext;
    this._cortexMdPrompt = buildCodexSystemPrompt(config.cwd || DATA_DIR);
    this._onClosed = onClosed;
    const stream = createEventStream<NormalizedEvent>();
    this.events = stream.iterable;
    this._push = stream.push;
    this._closeStream = stream.close;
  }

  send(message: UserMessage): Promise<AgentResult> {
    if (this._closed) return Promise.reject(new Error('CodexAdapterSession: send after close'));
    const files: SlackFile[] = (message.attachments || []).map((a) => ({
      mimetype: a.mimeType,
      localPath: a.path,
      name: path.basename(a.path),
    }));
    const handle = runCodexInternal(message.text, {
      channel: this._channel,
      sessionId: this.sessionId,
      files,
      callbackSource: this._callbackSource,
      cortexMdPrompt: this._cortexMdPrompt,
      context: this._context,
      _onNormalizedEvent: (e) => this._push(e),
      _onThreadIdResolved: (id) => {
        if (this.sessionId !== id) {
          this.sessionId = id;
          this._push({ type: 'session_started', sessionId: id });
        }
      },
    });
    this._activeHandle = handle;
    return handle.promise.then(
      (result) => {
        if (result.sessionId) this.sessionId = result.sessionId;
        this._push({
          type: 'turn_complete',
          numTurns: result.num_turns ?? 0,
          totalCostUsd: result.total_cost_usd,
        });
        return result;
      },
      (err: Error & { cancelled?: boolean }) => {
        if (!err.cancelled) {
          // kill() path: do not surface as event; event loop terminates via stream.close() from caller.
          this._push({ type: 'error', message: String(err.message || err), fatal: true });
        }
        throw err;
      },
    );
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._closeStream();
    this._onClosed();
  }

  kill(): boolean {
    return this._activeHandle?.kill() ?? false;
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly backend: Backend = 'codex';
  readonly capabilities: Set<Capability> = CAPABILITIES_BY_BACKEND.codex;

  private openSessions = new Map<string, CodexAdapterSession>();

  spawn(config: AgentSpawnConfig): AgentProcess {
    const session = new CodexAdapterSession(config, () => {
      this.openSessions.delete(config.sessionKey);
    });
    this.openSessions.set(config.sessionKey, session);
    return session;
  }

  async close(sessionKey: string): Promise<void> {
    const session = this.openSessions.get(sessionKey);
    if (session) await session.close();
  }

  kill(sessionKey: string): boolean {
    return this.openSessions.get(sessionKey)?.kill() ?? false;
  }

  listSessions(): string[] {
    return Array.from(this.openSessions.keys());
  }
}

export const _test = { stripCortexMcpSections };

export { runCodex, CancelledError, shutdownCodex, buildMcpBlock };
