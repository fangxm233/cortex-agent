import * as os from 'node:os';
import { runFile, type ExecOptions, type ExecResult } from '@core/exec-async.js';
import { createLogger } from '@core/log.js';
import { npmInvocation } from '@core/utils.js';
import { bumpClaudeCliGeneration } from '../../agent-adapter/claude/cli-generation.js';

const log = createLogger('claude-code-update');

/** The same command Claude runs spawn; `cliPath` overrides exist only for isolated trials. */
const CLAUDE = 'claude';
const NPM_PACKAGE = '@anthropic-ai/claude-code';
const LOOKUP_TIMEOUT_MS = 15_000;
/** A native install downloads a full binary; leave room for a slow link. */
const UPDATE_TIMEOUT_MS = 10 * 60_000;
const DETAIL_LINES = 8;
const VERSION = /(\d+\.\d+\.\d+)/;

export type ClaudeCodeUpdateState = 'idle' | 'checking' | 'updating' | 'failed';
export type ClaudeCodeFailure = 'not_installed' | 'lookup_failed' | 'update_failed';

export interface ClaudeCodeStatus {
  /** What the server's `claude --version` reports; null before the first check or when missing. */
  installed: string | null;
  /** Newest published version seen by the last check, or null when unknown. */
  latest: string | null;
  state: ClaudeCodeUpdateState;
  /** Set only in `failed`. */
  failure?: ClaudeCodeFailure;
  /** The last lines the failing command printed. */
  detail?: string;
  /** When the last check or update finished (ISO). Absent until one has. */
  checkedAt?: string;
}

type Run = (file: string, args: string[], opts: ExecOptions) => Promise<ExecResult>;

export interface ClaudeCodeUpdaterDeps {
  run: Run;
  now: () => string;
  /** Called once an update moved the installed version. */
  onInstalled: () => void;
}

type Lookup = { version: string | null; failure?: ClaudeCodeFailure; detail?: string };
type Outcome = Omit<ClaudeCodeStatus, 'checkedAt'>;

export function parseClaudeVersion(output: string): string | null {
  return VERSION.exec(output)?.[1] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
  }
  return 0;
}

function outputTail(result: ExecResult): string {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  return text.split('\n').slice(-DETAIL_LINES).join('\n').trim() || result.error || '';
}

/** Cortex's own runs switch Claude's auto-updater off; the explicit update must not inherit that. */
function updateEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DISABLE_AUTOUPDATER;
  return env;
}

function newestOf(latest: string | null, installed: string): string {
  return latest && compareVersions(latest, installed) > 0 ? latest : installed;
}

/** What one `claude update` run achieved, judged by the version before and after it. */
export function updateOutcome(
  result: ExecResult, before: string | null, after: string | null, latest: string | null,
): Outcome {
  if (!after) return { installed: null, latest, state: 'failed', failure: 'not_installed', detail: outputTail(result) };
  const newest = newestOf(latest, after);
  const moved = !before || compareVersions(after, before) > 0;
  if (moved || (result.ok && compareVersions(after, newest) >= 0)) return { installed: after, latest: newest, state: 'idle' };
  return { installed: after, latest: newest, state: 'failed', failure: 'update_failed', detail: outputTail(result) };
}

/** One per server: the Settings row and the chat-card button share its state and its single run. */
export class ClaudeCodeUpdater {
  private status: ClaudeCodeStatus = { installed: null, latest: null, state: 'idle' };
  private work: { kind: 'check' | 'update'; done: Promise<ClaudeCodeStatus> } | null = null;

  constructor(private readonly deps: ClaudeCodeUpdaterDeps) {}

  getStatus(): ClaudeCodeStatus {
    return this.status;
  }

  check(): Promise<ClaudeCodeStatus> {
    return this.work?.done ?? this.start('check', () => this.runCheck());
  }

  update(): Promise<ClaudeCodeStatus> {
    if (this.work?.kind === 'update') return this.work.done;
    if (this.work) return this.work.done.then(() => this.update());
    return this.start('update', () => this.runUpdate());
  }

  private start(kind: 'check' | 'update', task: () => Promise<Outcome>): Promise<ClaudeCodeStatus> {
    const { installed, latest, checkedAt } = this.status;
    this.status = { installed, latest, state: kind === 'check' ? 'checking' : 'updating', ...(checkedAt ? { checkedAt } : {}) };
    const done = task()
      .catch((error: unknown): Outcome => ({
        installed, latest, state: 'failed', failure: kind === 'check' ? 'lookup_failed' : 'update_failed',
        detail: error instanceof Error ? error.message : String(error),
      }))
      .then((outcome) => this.finish(outcome))
      .finally(() => { this.work = null; });
    this.work = { kind, done };
    return done;
  }

  private finish(outcome: Outcome): ClaudeCodeStatus {
    this.status = { ...outcome, checkedAt: this.deps.now() };
    return this.status;
  }

  private async runCheck(): Promise<Outcome> {
    const [installed, latest] = await Promise.all([this.readInstalled(), this.readLatest()]);
    const base = { installed: installed.version, latest: latest.version ?? this.status.latest };
    const failed = installed.failure ? installed : latest.failure ? latest : null;
    if (!failed) return { ...base, state: 'idle' };
    return { ...base, state: 'failed', failure: failed.failure, ...(failed.detail ? { detail: failed.detail } : {}) };
  }

  private async runUpdate(): Promise<Outcome> {
    const before = this.status.installed ?? (await this.readInstalled()).version;
    log.info(`claude update started (installed ${before ?? 'unknown'})`);
    const result = await this.deps.run(CLAUDE, ['update'], {
      env: updateEnv(), timeoutMs: UPDATE_TIMEOUT_MS, cwd: os.tmpdir(),
    });
    const after = (await this.readInstalled()).version;
    const outcome = updateOutcome(result, before, after, this.status.latest);
    if (outcome.state === 'idle' && after && before !== after) this.deps.onInstalled();
    log.info(`claude update finished: ${before ?? 'unknown'} -> ${after ?? 'missing'} (${outcome.state})`);
    return outcome;
  }

  private async readInstalled(): Promise<Lookup> {
    const result = await this.deps.run(CLAUDE, ['--version'], { timeoutMs: LOOKUP_TIMEOUT_MS, cwd: os.tmpdir() });
    const version = result.ok ? parseClaudeVersion(result.stdout) : null;
    return version ? { version } : { version: null, failure: 'not_installed', detail: outputTail(result) };
  }

  private async readLatest(): Promise<Lookup> {
    const npm = npmInvocation(['view', NPM_PACKAGE, 'version']);
    const result = await this.deps.run(npm.command, npm.args, {
      shell: npm.shell, timeoutMs: LOOKUP_TIMEOUT_MS, cwd: os.tmpdir(),
    });
    const version = result.ok ? parseClaudeVersion(result.stdout) : null;
    return version ? { version } : { version: null, failure: 'lookup_failed', detail: outputTail(result) };
  }
}

export const claudeCodeUpdater = new ClaudeCodeUpdater({
  run: (file, args, opts) => runFile(file, args, opts),
  now: () => new Date().toISOString(),
  onInstalled: bumpClaudeCliGeneration,
});
