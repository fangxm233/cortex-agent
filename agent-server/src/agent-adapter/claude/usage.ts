// input:  Claude control protocol, requested provider scope, usage model
// output: Scoped normalized usage readings, subscription-mode probe env
// pos:    Short-lived Claude account usage collector
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { DATA_DIR } from '@core/utils.js';
import {
  UsageUnavailableError,
  type ProviderUsage,
  type UsageWindow,
} from '@domain/costs/usage-store.js';
import type { AgentUsageScope } from '../types.js';

export const CLAUDE_USAGE_TIMEOUT_MS = 15_000;

/** Platform keys the probe needs, plus the subscription token when the daemon holds one.
 *  ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL are deliberately absent: an inherited API key puts the
 *  CLI in API-key mode, where get_usage answers rate_limits_available=false without ever calling
 *  the account quota endpoint. Account usage is a subscription question, so the probe asks it in
 *  subscription mode regardless of which gateway route the daemon last configured. */
const USAGE_ENV_ALLOWLIST = [
  'HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
  'TMPDIR', 'TMP', 'TEMP',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

export function buildClaudeUsageEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of USAGE_ENV_ALLOWLIST) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

export interface ClaudeUsageProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: 'close' | 'error', listener: (...args: any[]) => void): this;
  removeListener(event: 'close' | 'error', listener: (...args: any[]) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type ClaudeUsageSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ClaudeUsageProcess;

export type ClaudeUsageCollector = (
  scope: AgentUsageScope,
) => Promise<ProviderUsage[] | null>;

export interface ClaudeUsageCollectorDeps {
  spawn?: ClaudeUsageSpawn;
  requestId?: () => string;
  now?: () => number;
  timeoutMs?: number;
  cwd?: string;
  cliPath?: string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function utilization(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`Malformed Claude usage utilization at ${field}`);
  }
  return value / 100;
}

function resetEpoch(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`Malformed Claude usage reset at ${field}`);
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) throw new Error(`Malformed Claude usage reset at ${field}`);
  return epochMs / 1000;
}

function windowRecord(value: unknown): JsonRecord | null {
  const record = asRecord(value);
  return record && ('utilization' in record || 'resets_at' in record) ? record : null;
}

function usageWindow(type: string, record: JsonRecord): UsageWindow {
  return {
    type,
    utilization: utilization(record['utilization'], `${type}.utilization`),
    resetsAt: resetEpoch(record['resets_at'], `${type}.resets_at`),
  };
}

function modelWindows(value: unknown): UsageWindow[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Malformed Claude usage model_scoped windows');
  return value.map((entry, index) => {
    const record = asRecord(entry);
    if (!record || typeof record['display_name'] !== 'string') {
      throw new Error(`Malformed Claude usage model_scoped window ${index}`);
    }
    return {
      ...usageWindow('model_scoped', record),
      label: record['display_name'],
    };
  });
}

function normalizedWindows(response: unknown): UsageWindow[] {
  const payload = asRecord(response);
  if (!payload) throw new Error('Malformed Claude usage response: missing rate_limits');
  const rateLimits = asRecord(payload['rate_limits']);
  if (!rateLimits || payload['rate_limits_available'] === false) {
    // A hard rate-limited account answers get_usage without rate_limits; a provider state, not corruption.
    throw new UsageUnavailableError(
      'Anthropic quota data temporarily unavailable (account rate-limited); showing last reading',
    );
  }
  const windows = Object.entries(rateLimits)
    .filter(([type]) => type !== 'model_scoped' && type !== 'extra_usage')
    .flatMap(([type, value]) => {
      const record = windowRecord(value);
      if (!record) return []; // rate_limits is an open set: skip non-window entries
      const window = usageWindow(type, record);
      return window.utilization === null && window.resetsAt === null ? [] : [window];
    });
  return [...windows, ...modelWindows(rateLimits['model_scoped'])];
}

function scopedUsage(
  scope: Required<AgentUsageScope>,
  response: unknown,
  observedAtMs: number,
): ProviderUsage[] {
  return [{
    provider: scope.provider,
    displayName: scope.provider === 'anthropic' ? 'Anthropic' : scope.provider,
    modes: [scope.mode],
    windows: normalizedWindows(response),
    observedAt: Math.floor(observedAtMs / 1000),
    freshness: 'live',
  }];
}

function errorMessage(envelope: JsonRecord): string {
  const error = envelope['error'];
  if (typeof error === 'string') return error;
  const nested = asRecord(error)?.['message'];
  return typeof nested === 'string' ? nested : 'Claude get_usage control request failed';
}

function usageArgs(sessionId: string): string[] {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
    '--strict-mcp-config', '--session-id', sessionId,
  ];
}

function completeScope(scope: AgentUsageScope): Required<AgentUsageScope> | null {
  if (!scope.provider || !scope.mode) return null;
  return { provider: scope.provider, mode: scope.mode };
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ClaudeUsageProcess {
  return nodeSpawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
}

export async function collectClaudeUsage(
  requestedScope: AgentUsageScope,
  deps: ClaudeUsageCollectorDeps = {},
): Promise<ProviderUsage[] | null> {
  const scope = completeScope(requestedScope);
  if (!scope) return null;
  return runUsageProcess(scope, deps);
}

function runUsageProcess(
  scope: Required<AgentUsageScope>,
  deps: ClaudeUsageCollectorDeps,
): Promise<ProviderUsage[]> {
  const requestId = (deps.requestId ?? randomUUID)();
  const child = (deps.spawn ?? defaultSpawn)(
    deps.cliPath ?? 'claude', usageArgs(randomUUID()),
    { cwd: deps.cwd ?? DATA_DIR, env: buildClaudeUsageEnv() },
  );
  return new ClaudeUsageRequest(child, scope, requestId, deps).run();
}

class ClaudeUsageRequest {
  private readonly lines;
  private stderr = '';
  private settled = false;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private resolve!: (usage: ProviderUsage[]) => void;
  private reject!: (error: Error) => void;

  constructor(
    private readonly child: ClaudeUsageProcess,
    private readonly scope: Required<AgentUsageScope>,
    private readonly requestId: string,
    private readonly deps: ClaudeUsageCollectorDeps,
  ) {
    this.lines = createInterface({ input: child.stdout });
  }

  run(): Promise<ProviderUsage[]> {
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.timeout = setTimeout(
        () => this.fail(new Error('Claude get_usage timed out')),
        this.deps.timeoutMs ?? CLAUDE_USAGE_TIMEOUT_MS,
      );
      this.child.stderr.on('data', this.onStderr);
      // Keep this sink through kill so a late EPIPE cannot escape as an uncaught stream error.
      this.child.stdin.on('error', this.fail);
      this.child.once('close', this.onClose);
      this.child.once('error', this.fail);
      this.lines.on('line', this.onLine);
      this.writeRequest();
    });
  }

  private writeRequest(): void {
    const request = {
      type: 'control_request', request_id: this.requestId, request: { subtype: 'get_usage' },
    };
    try {
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) this.fail(error);
      });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private cleanup(): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.lines.close();
    this.child.stderr.removeListener('data', this.onStderr);
    this.child.removeListener('close', this.onClose);
    this.child.removeListener('error', this.fail);
    try { this.child.stdin.end(); } catch { /* process already closed */ }
    if (this.child.exitCode === null) {
      try { this.child.kill('SIGKILL'); } catch { /* process already closed */ }
    }
  }

  private readonly fail = (error: Error): void => {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.reject(error);
  };

  private succeed(response: unknown): void {
    if (this.settled) return;
    try {
      const usage = scopedUsage(this.scope, response, (this.deps.now ?? Date.now)());
      this.settled = true;
      this.cleanup();
      this.resolve(usage);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private readonly onStderr = (chunk: Buffer | string): void => {
    this.stderr = (this.stderr + chunk.toString()).slice(-4096);
  };

  private readonly onClose = (code: number | null): void => {
    const detail = this.stderr.trim() || `exit code ${String(code)}`;
    this.fail(new Error(`Claude get_usage process exited before response: ${detail}`));
  };

  private readonly onLine = (line: string): void => {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch {
      this.fail(new Error('Malformed Claude usage JSON response'));
      return;
    }
    const message = asRecord(raw);
    if (message?.['type'] !== 'control_response') return;
    const envelope = asRecord(message['response']);
    if (!envelope || typeof envelope['request_id'] !== 'string') {
      this.fail(new Error('Malformed Claude usage control response'));
      return;
    }
    if (envelope['request_id'] !== this.requestId) return;
    if (envelope['subtype'] !== 'success') this.fail(new Error(errorMessage(envelope)));
    else this.succeed(envelope['response']);
  };
}
