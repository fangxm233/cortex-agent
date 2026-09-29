import { spawnSync } from 'child_process';

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

/**
 * Stateless tmux command wrapper. All side effects flow through the injected exec — tests inject mocks,
 * production uses {@link defaultTmuxExec}. No internal state means safe concurrent use.
 *
 * D9 retired the Claude TUI mode, so this is no longer on any live turn path. It survives as the
 * tool behind {@link recoverTuiOrphans}: a one-way MIGRATION SWEEP that kills tmux sessions left
 * behind by pre-D9 builds on the first startup after an upgrade. It becomes deletable once that
 * deprecation window closes.
 */
export class TmuxControl {
  constructor(private readonly exec: TmuxExec = defaultTmuxExec) {}

  /** Kill a tmux session. Idempotent: missing session is not an error (matches tmux's own semantics for our use case). */
  killSession(name: string): void {
    this.exec(['kill-session', '-t', name]);
    // Intentionally ignore status — if the session is already gone, we're done.
  }

  /**
   * List all tmux session names on the server, optionally filtered by prefix.
   * Returns [] if no tmux server is running (status != 0) — graceful for the "agent-server startup
   * with no prior tmux state" case.
   *
   * Used by the {@link recoverTuiOrphans} migration sweep, not by a live TUI mode (D9).
   */
  listSessions(prefix?: string): string[] {
    const r = this.exec(['list-sessions', '-F', '#{session_name}']);
    if (r.status !== 0) return [];
    const names = r.stdout.split('\n').map(s => s.trim()).filter(s => s.length > 0);
    if (!prefix) return names;
    return names.filter(n => n.startsWith(prefix));
  }
}
