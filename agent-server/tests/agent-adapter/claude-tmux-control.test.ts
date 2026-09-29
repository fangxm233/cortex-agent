// NOT retired by D9: `TmuxControl` still backs `recoverTuiOrphans`, which runs on every daemon
// startup to sweep tmux sessions left by pre-D9 builds.
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { TmuxControl, type TmuxExecResult } from '../../src/agent-adapter/claude/tmux-control.js';

// --- Helpers ---

interface ExecCall {
  args: string[];
}

function makeMockExec(responses: Array<Partial<TmuxExecResult>>): { exec: (args: string[]) => TmuxExecResult; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  let i = 0;
  const exec = (args: string[]): TmuxExecResult => {
    calls.push({ args });
    const r = responses[i++] || {};
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 0 };
  };
  return { exec, calls };
}

// --- killSession ---

test('killSession builds correct argv and is idempotent on missing session', () => {
  const { exec, calls } = makeMockExec([{ status: 1, stderr: "can't find session" }]);
  const t = new TmuxControl(exec);
  // Idempotent: should NOT throw even if session is gone
  t.killSession('cortex-claude-aaa');
  assert.deepEqual(calls[0].args, ['kill-session', '-t', 'cortex-claude-aaa']);
});

// --- listSessions ---

test('listSessions parses tmux ls -F output and filters by prefix', () => {
  const { exec, calls } = makeMockExec([{
    stdout: 'cortex-claude-aaa\ncortex-claude-bbb\nother-session\nirrelevant\n',
    status: 0,
  }]);
  const t = new TmuxControl(exec);
  const names = t.listSessions('cortex-claude-');
  assert.deepEqual(names, ['cortex-claude-aaa', 'cortex-claude-bbb']);
  assert.deepEqual(calls[0].args, ['list-sessions', '-F', '#{session_name}']);
});

test('listSessions returns empty list when tmux server not running (status=1)', () => {
  const { exec } = makeMockExec([{ status: 1, stderr: 'no server running' }]);
  const t = new TmuxControl(exec);
  assert.deepEqual(t.listSessions(), []);
});
