// input:  child processes, filesystem, and tmux argv
// output: TmuxControl and launcher staging
// pos:    Claude tmux command wrapper
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export interface TmuxExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

export type TmuxExec = (args: string[]) => TmuxExecResult;

/** Default exec: forks real tmux via spawnSync. Tests inject a mock exec to avoid touching the real tmux server. */
export const defaultTmuxExec: TmuxExec = (args) => {
  const r = spawnSync('tmux', args, { encoding: 'utf-8' });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: typeof r.status === 'number' ? r.status : -1,
  };
};

export interface NewSessionOptions {
  /** tmux session name, e.g. "cortex-claude-<sessionId>" */
  name: string;
  /** Command argv to run inside the session, e.g. ['claude', '--session-id', '...'] */
  command: string[];
  /** Working directory for the spawned shell/command (tmux -c) */
  cwd: string;
  /** Extra environment variables surfaced to the child via tmux -e (each entry becomes "-e KEY=VAL") */
  env?: Record<string, string>;
  /** Pane columns (tmux -x). Default 200. */
  cols?: number;
  /** Pane rows (tmux -y). Default 50. */
  rows?: number;
}

/**
 * Stateless tmux command wrapper. All side effects flow through the injected exec — tests inject mocks,
 * production uses {@link defaultTmuxExec}. No internal state means safe concurrent use.
 *
 * @see DR-0012 §3.1 (architecture) — this is the bottom-most utility used by adapter-tui.
 */
export class TmuxControl {
  constructor(private readonly exec: TmuxExec = defaultTmuxExec) {}

  /** Returns true iff `tmux has-session -t <name>` exits 0. */
  hasSession(name: string): boolean {
    const r = this.exec(['has-session', '-t', name]);
    return r.status === 0;
  }

  /**
   * Create a detached tmux session running the given command in the given cwd.
   * Throws on tmux non-zero exit (e.g. duplicate session name).
   *
   * Env + command are NOT placed on the tmux command line. tmux packs the whole new-session
   * invocation (argv + every `-e KEY=VAL`) into a single control-socket imsg with a ~16KB ceiling;
   * the agent-server's full environment (~8KB+) plus claude's long `--append-system-prompt` /
   * `--settings` arguments blow past it ("command too long"). Instead we stage a launcher script
   * that exports the env and `exec`s the command, so the tmux command line stays a few dozen bytes.
   * @see DR-0012 — TUI command-length fix.
   */
  newSession(opts: NewSessionOptions): void {
    const cols = opts.cols ?? 200;
    const rows = opts.rows ?? 50;
    const launcherPath = writeLauncherScript(opts.env ?? {}, opts.command);
    const args: string[] = [
      'new-session', '-d', '-s', opts.name,
      '-c', opts.cwd,
      '-x', String(cols), '-y', String(rows),
      '--',
      'bash', launcherPath,
    ];
    const r = this.exec(args);
    if (r.status !== 0) {
      // The launcher normally self-deletes once bash runs it; on a failed spawn bash never runs,
      // so clean it up here to avoid leaking the staged script.
      try { fs.unlinkSync(launcherPath); } catch { /* best effort */ }
      throw new Error(`tmux new-session failed (status=${r.status}): ${r.stderr.trim() || r.stdout.trim() || '<no stderr>'}`);
    }
  }

  /** Kill a tmux session. Idempotent: missing session is not an error (matches tmux's own semantics for our use case). */
  killSession(name: string): void {
    this.exec(['kill-session', '-t', name]);
    // Intentionally ignore status — if the session is already gone, we're done.
  }

  /**
   * Send one or more tmux key tokens to the session. Tokens are passed verbatim to tmux,
   * so callers can use 'Enter', 'Escape', 'C-u', etc. No-op when no keys supplied.
   */
  sendKeys(name: string, ...keys: string[]): void {
    if (keys.length === 0) return;
    this.exec(['send-keys', '-t', name, ...keys]);
  }

  /**
   * Paste arbitrary text without exposing it in process argv. A unique 0600 tempfile feeds a named
   * tmux buffer; cleanup explicitly removes both artifacts on success and every failure path.
   * Does not submit Enter. `-p` supplies the bracketed-paste sequences required by Claude's Ink TUI.
   */
  pasteText(name: string, text: string): void {
    const bufName = `cortex-${crypto.randomBytes(6).toString('hex')}`;
    const tmpfile = path.join(os.tmpdir(), `cortex-tmux-paste-${bufName}.txt`);
    let bufferLoaded = false;
    fs.writeFileSync(tmpfile, text, { encoding: 'utf8', mode: 0o600 });
    try {
      const loaded = this.exec(['load-buffer', '-b', bufName, tmpfile]);
      if (loaded.status !== 0) {
        throw new Error(`tmux load-buffer failed (status=${loaded.status}): ${loaded.stderr.trim()}`);
      }
      bufferLoaded = true;
      const pasted = this.exec(['paste-buffer', '-p', '-b', bufName, '-t', name]);
      if (pasted.status !== 0) {
        throw new Error(`tmux paste-buffer failed (status=${pasted.status}): ${pasted.stderr.trim()}`);
      }
    } finally {
      cleanupPasteArtifacts(this.exec, bufName, tmpfile, bufferLoaded);
    }
  }

  /** Read visible pane content for TUI diagnostics and bounded authentication parsing. */
  capturePane(name: string): string {
    const r = this.exec(['capture-pane', '-t', name, '-p']);
    return r.stdout;
  }

  /**
   * List all tmux session names on the server, optionally filtered by prefix.
   * Returns [] if no tmux server is running (status != 0) — graceful for the "agent-server startup
   * with no prior tmux state" case.
   *
   * @see DR-0012 §3.6 — used at agent-server startup to discover orphan TUI sessions for re-adoption.
   */
  listSessions(prefix?: string): string[] {
    const r = this.exec(['list-sessions', '-F', '#{session_name}']);
    if (r.status !== 0) return [];
    const names = r.stdout.split('\n').map(s => s.trim()).filter(s => s.length > 0);
    if (!prefix) return names;
    return names.filter(n => n.startsWith(prefix));
  }
}

function cleanupPasteArtifacts(
  exec: TmuxExec,
  bufferName: string,
  tempfile: string,
  bufferLoaded: boolean,
): void {
  let failed = false;
  try { fs.unlinkSync(tempfile); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed = true;
  }
  try {
    const deleted = exec(['delete-buffer', '-b', bufferName]);
    if (bufferLoaded && deleted.status !== 0) failed = true;
  } catch {
    if (bufferLoaded) failed = true;
  }
  if (failed) throw new Error('tmux paste cleanup failed.');
}

// =====================================================================================
//  Launcher script staging (newSession command-length workaround)
// =====================================================================================

/** POSIX single-quote escape: wrap in '…' and rewrite embedded ' as '\''. Safe for arbitrary
 *  bytes including newlines, backticks, `$`, and quotes (verified against the claude system-prompt
 *  payload). */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Only export env keys that are valid POSIX shell identifiers. Skips exotic keys such as
 *  bash-exported functions (`BASH_FUNC_xxx%%`) whose names would break an `export` statement. */
const SHELL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Write a self-deleting bash launcher that exports `env` then `exec`s `command`, returning its path.
 * On Linux the open file descriptor keeps the script readable after `rm "$0"`, so bash finishes
 * reading the remaining lines from the still-open inode (verified). The caller runs it via
 * `tmux new-session -- bash <path>`; on a failed spawn the caller unlinks it instead.
 */
export function writeLauncherScript(env: Record<string, string>, command: string[]): string {
  const id = crypto.randomBytes(6).toString('hex');
  const launcherPath = path.join(os.tmpdir(), `cortex-tmux-launch-${id}.sh`);
  const lines: string[] = ['#!/usr/bin/env bash', 'rm -f "$0"'];
  for (const [k, v] of Object.entries(env)) {
    if (!SHELL_IDENT.test(k)) continue;
    lines.push(`export ${k}=${shQuote(v)}`);
  }
  lines.push(`exec ${command.map(shQuote).join(' ')}`);
  fs.writeFileSync(launcherPath, lines.join('\n') + '\n', { mode: 0o700 });
  return launcherPath;
}
