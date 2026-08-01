// input:  tmux command argv, filesystem, temp directory
// output: TmuxControl and private launcher/paste staging
// pos:    Shared tmux command wrapper for Claude TUI sessions
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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
   * Paste arbitrary text (including multi-line + non-ASCII + shell metachars) into the session's
   * input area without submitting it. Internally: write text to a tempfile → tmux load-buffer (named
   * buffer to avoid concurrent collisions) → tmux paste-buffer -d (free buffer after paste) → unlink tempfile.
   *
   * Does NOT send Enter — caller decides whether to submit (typically `sendKeys(name, 'Enter')` after).
   *
   * Why a named buffer + -d: tmux has a global anonymous paste buffer; concurrent sessions on the same
   * tmux server would race. Named buffers + -d (auto-delete after paste) avoid that.
   *
   * Why -p (bracketed paste): Claude's Ink TUI only registers input wrapped in bracketed-paste escape
   * sequences (ESC[200~ … ESC[201~) as a paste. Without -p (Claude ≥2.1.162) the text lands but the
   * prompt buffer never accepts it, so the follow-up Enter submits nothing and no jsonl is written —
   * the turn then dies on the first-event watchdog. Verified: with -p, paste→Enter submits and Claude
   * responds; without it the pane goes blank and the transcript only contains session-init lines.
   *
   * @see DR-0012 spike §4 — paste-buffer is more reliable than send-keys -l for special chars.
   */
  pasteText(name: string, text: string): void {
    const bufName = `cortex-${crypto.randomBytes(6).toString('hex')}`;
    const tmpfile = path.join(os.tmpdir(), `cortex-tmux-paste-${bufName}.txt`);
    fs.writeFileSync(tmpfile, text, { encoding: 'utf8', mode: 0o600 });
    try {
      const r1 = this.exec(['load-buffer', '-b', bufName, tmpfile]);
      if (r1.status !== 0) {
        throw new Error(`tmux load-buffer failed (status=${r1.status}): ${r1.stderr.trim()}`);
      }
      const r2 = this.exec(['paste-buffer', '-p', '-d', '-b', bufName, '-t', name]);
      if (r2.status !== 0) {
        throw new Error(`tmux paste-buffer failed (status=${r2.status}): ${r2.stderr.trim()}`);
      }
    } finally {
      try { fs.unlinkSync(tmpfile); } catch { /* best effort */ }
    }
  }

  /** Read the current visible pane content. Used only for diagnostics — production paths rely on jsonl. */
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
