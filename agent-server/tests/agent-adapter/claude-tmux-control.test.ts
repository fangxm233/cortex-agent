// input:  Node test runner + agent-adapter/claude/tmux-control module
// output: TmuxControl pure-function argv + tempfile spec lock-down (DR-0012 Phase 1)
// pos:    Claude TUI adapter foundational utility regression tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

// --- hasSession ---

test('hasSession returns true when tmux has-session exits 0', () => {
  const { exec, calls } = makeMockExec([{ status: 0 }]);
  const t = new TmuxControl(exec);
  assert.equal(t.hasSession('cortex-claude-aaa'), true);
  assert.deepEqual(calls[0].args, ['has-session', '-t', 'cortex-claude-aaa']);
});

test('hasSession returns false when tmux has-session exits non-zero', () => {
  const { exec } = makeMockExec([{ status: 1, stderr: "can't find session" }]);
  const t = new TmuxControl(exec);
  assert.equal(t.hasSession('cortex-claude-bbb'), false);
});

// --- newSession ---

// newSession stages env + command into a self-deleting bash launcher (DR-0012 command-length fix);
// tmux only ever sees `-- bash <launcherPath>`. These tests read the staged launcher off disk via
// the captured path (mock exec never runs bash, so the script is not self-deleted — the test cleans it).

test('newSession builds detached argv that runs a bash launcher (env/command off the command line)', () => {
  const { exec, calls } = makeMockExec([{ status: 0 }]);
  const t = new TmuxControl(exec);
  t.newSession({
    name: 'cortex-claude-aaa',
    command: ['claude', '--session-id', 'uuid-1'],
    cwd: '/some/dir',
  });
  const args = calls[0].args;
  // Prefix is fixed; final two tokens are `bash <launcherPath>`.
  assert.deepEqual(args.slice(0, 11), [
    'new-session', '-d', '-s', 'cortex-claude-aaa',
    '-c', '/some/dir',
    '-x', '200', '-y', '50',
    '--',
  ]);
  assert.equal(args[11], 'bash');
  const launcherPath = args[12];
  assert.ok(/cortex-tmux-launch-[0-9a-f]+\.sh$/.test(launcherPath), 'last arg is the launcher script path');
  // No env/command leaks onto the tmux command line.
  assert.ok(!args.includes('-e'), 'env must not be passed via -e');
  assert.ok(!args.includes('claude'), 'command must not be inlined on the tmux command line');
  // Launcher content: exports env and execs the command.
  const script = fs.readFileSync(launcherPath, 'utf8');
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /rm -f "\$0"/);
  assert.match(script, /exec 'claude' '--session-id' 'uuid-1'/);
  fs.unlinkSync(launcherPath);
});

test('newSession honors custom dimensions and exports env in the launcher (quoted, identifier-only)', () => {
  const { exec, calls } = makeMockExec([{ status: 0 }]);
  const t = new TmuxControl(exec);
  t.newSession({
    name: 'cortex-claude-aaa',
    command: ['claude'],
    cwd: '/tmp',
    // include a tricky value (quote + newline) and an invalid shell-identifier key that must be skipped
    env: { FOO: 'bar', BAZ: "qu'x\nline2", 'BASH_FUNC_x%%': 'fn' },
    cols: 120,
    rows: 40,
  });
  const args = calls[0].args;
  assert.ok(args.includes('-x') && args[args.indexOf('-x') + 1] === '120');
  assert.ok(args.includes('-y') && args[args.indexOf('-y') + 1] === '40');
  const launcherPath = args[args.length - 1];
  const script = fs.readFileSync(launcherPath, 'utf8');
  assert.match(script, /export FOO='bar'/);
  // single-quote escape: ' -> '\'' , newline preserved verbatim inside the quotes
  assert.match(script, /export BAZ='qu'\\''x\nline2'/);
  // invalid identifier key is skipped, not exported
  assert.ok(!script.includes('BASH_FUNC_x'), 'non-identifier env keys must be skipped');
  fs.unlinkSync(launcherPath);
});

test('newSession throws when tmux exits non-zero and cleans up the staged launcher', () => {
  const captured: string[][] = [];
  const exec = (args: string[]) => { captured.push(args); return { stdout: '', stderr: 'duplicate session', status: 1 }; };
  const t = new TmuxControl(exec);
  assert.throws(
    () => t.newSession({ name: 'dup', command: ['claude'], cwd: '/tmp' }),
    /tmux new-session failed.*duplicate session/,
  );
  // On failure the launcher must be unlinked (bash never ran to self-delete it).
  const launcherPath = captured[0][captured[0].length - 1];
  assert.ok(!fs.existsSync(launcherPath), 'failed spawn must clean up the staged launcher');
});

// --- killSession ---

test('killSession builds correct argv and is idempotent on missing session', () => {
  const { exec, calls } = makeMockExec([{ status: 1, stderr: "can't find session" }]);
  const t = new TmuxControl(exec);
  // Idempotent: should NOT throw even if session is gone
  t.killSession('cortex-claude-aaa');
  assert.deepEqual(calls[0].args, ['kill-session', '-t', 'cortex-claude-aaa']);
});

// --- sendKeys ---

test('sendKeys passes -t and key tokens through verbatim', () => {
  const { exec, calls } = makeMockExec([{ status: 0 }]);
  const t = new TmuxControl(exec);
  t.sendKeys('cortex-claude-aaa', 'Escape');
  assert.deepEqual(calls[0].args, ['send-keys', '-t', 'cortex-claude-aaa', 'Escape']);

  const { exec: e2, calls: c2 } = makeMockExec([{ status: 0 }]);
  const t2 = new TmuxControl(e2);
  t2.sendKeys('foo', 'C-u');
  assert.deepEqual(c2[0].args, ['send-keys', '-t', 'foo', 'C-u']);
});

test('sendKeys with multiple keys joins them in one invocation', () => {
  const { exec, calls } = makeMockExec([{ status: 0 }]);
  const t = new TmuxControl(exec);
  t.sendKeys('foo', 'C-u', 'Enter');
  assert.deepEqual(calls[0].args, ['send-keys', '-t', 'foo', 'C-u', 'Enter']);
});

test('sendKeys with empty key list is a no-op (does not invoke tmux)', () => {
  const { exec, calls } = makeMockExec([]);
  const t = new TmuxControl(exec);
  t.sendKeys('foo');
  assert.equal(calls.length, 0);
});

// --- pasteText (load-buffer + paste-buffer) ---

test('pasteText writes a tempfile, loads it into buffer, pastes, and cleans up', async (tCtx) => {
  // Real tempfile path captured via mock exec — we'll inspect it before tmux pretends to consume it
  let observedTempfile: string | null = null;
  let observedContent: string | null = null;
  const exec = (args: string[]): TmuxExecResult => {
    if (args[0] === 'load-buffer') {
      // args: ['load-buffer', '-b', '<bufname>', <path>]
      const p = args[args.length - 1];
      observedTempfile = p;
      try { observedContent = fs.readFileSync(p, 'utf8'); } catch {}
    }
    return { stdout: '', stderr: '', status: 0 };
  };
  const t = new TmuxControl(exec);
  const text = 'hello\n你好\n`$\\"\'';
  t.pasteText('cortex-claude-aaa', text);

  assert.equal(observedContent, text, 'tempfile content must match input exactly');
  assert.ok(observedTempfile !== null);
  assert.ok(!fs.existsSync(observedTempfile!), 'tempfile should be deleted after paste');
});

test('pasteText invokes load-buffer with a named buffer, paste-buffer with -d to delete after paste', () => {
  const { exec, calls } = makeMockExec([
    { status: 0 }, // load-buffer
    { status: 0 }, // paste-buffer
  ]);
  const t = new TmuxControl(exec);
  t.pasteText('cortex-claude-aaa', 'hi');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[0], 'load-buffer');
  // Buffer is named (so concurrent calls don't collide) and -t/target session present
  const loadArgs = calls[0].args;
  assert.ok(loadArgs.includes('-b'), 'load-buffer must use named buffer (-b)');
  assert.equal(calls[1].args[0], 'paste-buffer');
  assert.ok(calls[1].args.includes('-p'), 'paste-buffer must use -p (bracketed paste) so Claude registers the paste');
  assert.ok(calls[1].args.includes('-d'), 'paste-buffer must use -d to free buffer after paste');
  assert.ok(calls[1].args.includes('-t'), 'paste-buffer must target the session');
});

// --- capturePane ---

test('capturePane returns stdout', () => {
  const { exec, calls } = makeMockExec([{ stdout: 'line1\nline2\n', status: 0 }]);
  const t = new TmuxControl(exec);
  const out = t.capturePane('foo');
  assert.equal(out, 'line1\nline2\n');
  assert.deepEqual(calls[0].args, ['capture-pane', '-t', 'foo', '-p']);
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

test('listSessions with no prefix returns all sessions', () => {
  const { exec } = makeMockExec([{
    stdout: 'a\nb\nc\n',
    status: 0,
  }]);
  const t = new TmuxControl(exec);
  assert.deepEqual(t.listSessions(), ['a', 'b', 'c']);
});
