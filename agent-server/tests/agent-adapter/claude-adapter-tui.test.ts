// input:  Node test runner + agent-adapter/claude/adapter-tui module
// output: ClaudeTuiSession turn lifecycle + cancel + cost + plan/ask aggregation spec lock-down
// pos:    DR-0012 Phase 2 — TUI adapter state-machine regression tests (mocked tmux + jsonl tail)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import * as fs from 'fs';

import { ClaudeTuiSession, type TuiSessionDeps } from '../../src/agent-adapter/claude/adapter-tui.js';
import type { TmuxExecResult } from '../../src/agent-adapter/claude/tmux-control.js';
import { TmuxControl } from '../../src/agent-adapter/claude/tmux-control.js';

// --- Test scaffolding ---

interface TmuxCallLog {
  args: string[];
}

/** The claude argv (and env) no longer ride on the tmux command line — newSession stages them into
 *  a self-deleting bash launcher and tmux runs `-- bash <launcherPath>` (DR-0012 command-length fix).
 *  Command-shape assertions read the launcher back off disk; substring checks still match because
 *  each arg is single-quoted inside the `exec …` line. Mock exec never runs bash, so we unlink here. */
function launcherScriptFor(call: TmuxCallLog): string {
  const p = call.args[call.args.length - 1];
  const content = fs.readFileSync(p, 'utf8');
  try { fs.unlinkSync(p); } catch { /* best effort */ }
  return content;
}

function makeRecordingExec(): { exec: (args: string[]) => TmuxExecResult; calls: TmuxCallLog[] } {
  const calls: TmuxCallLog[] = [];
  const exec = (args: string[]): TmuxExecResult => {
    calls.push({ args });
    // Simulate live tmux server: has-session returns 0 only AFTER new-session has been called.
    if (args[0] === 'has-session') {
      const target = args[args.indexOf('-t') + 1];
      const created = calls.some(c => c.args[0] === 'new-session' && c.args.includes(target));
      const killed = calls.some(c => c.args[0] === 'kill-session' && c.args.includes(target) && calls.indexOf(c) > calls.findIndex(c2 => c2.args[0] === 'new-session' && c2.args.includes(target)));
      return { stdout: '', stderr: '', status: (created && !killed) ? 0 : 1 };
    }
    return { stdout: '', stderr: '', status: 0 };
  };
  return { exec, calls };
}

class MockTail extends EventEmitter {
  started = false;
  stopped = false;
  startCalls = 0;
  stopCalls = 0;
  constructor(public readonly path: string) { super(); }
  async start(): Promise<void> { this.started = true; this.startCalls++; }
  async stop(): Promise<void> { this.stopped = true; this.stopCalls++; }
  /** Drive the session by simulating a jsonl line being parsed and emitted. */
  push(raw: any): void { this.emit('event', raw); }
  /** Convenience: simulate a `system/turn_duration` boundary. */
  finishTurn(durationMs = 1000): void {
    this.emit('event', { type: 'system', subtype: 'turn_duration', durationMs });
    this.emit('turn-end', { durationMs });
  }
}

function makeDeps(): {
  deps: TuiSessionDeps;
  tmuxCalls: TmuxCallLog[];
  tails: MockTail[];
} {
  const { exec, calls: tmuxCalls } = makeRecordingExec();
  const tails: MockTail[] = [];
  const deps: TuiSessionDeps = {
    tmux: new TmuxControl(exec),
    tailFactory: (path: string) => {
      const t = new MockTail(path);
      tails.push(t);
      return t as any;
    },
    waitForJsonlMs: 0, // skip the file-wait poll in tests
    pasteSubmitDelayMs: 0, // submit synchronously in tests (no Ink TUI to settle)
    paneReadyTimeoutMs: 0, // skip pane-readiness poll in tests (mocked tmux renders no pane)
  };
  return { deps, tmuxCalls, tails };
}

function makeSession(deps: TuiSessionDeps, overrides: Partial<ConstructorParameters<typeof ClaudeTuiSession>[0]> = {}): ClaudeTuiSession {
  return new ClaudeTuiSession({
    channel: 'C-test',
    sessionId: 'sid-aaaa-bbbb',
    sessionKey: 'C-test',
    cwd: '/tmp/cortex-test',
    needsResume: false,
    deps,
    ...overrides,
  });
}

// =====================================================================================
//  spawnTmux + first-message lifecycle
// =====================================================================================

test('first sendMessage spawns tmux with --session-id and starts the jsonl tail', async (t) => {
  const { deps, tmuxCalls, tails } = makeDeps();
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  const turnPromise = sess.sendMessage('hello', {});
  // sendMessage is async — let the spawn + paste happen
  await new Promise(r => setImmediate(r));

  const newSessCall = tmuxCalls.find(c => c.args[0] === 'new-session');
  assert.ok(newSessCall, 'new-session must be invoked on first turn');
  // Session name follows TUI_TMUX_NAME_PREFIX convention
  const tIdx = newSessCall!.args.indexOf('-s');
  assert.match(newSessCall!.args[tIdx + 1], /^cortex-claude-/);
  // Command (staged in the launcher) must include claude + --session-id <sid>
  const script = launcherScriptFor(newSessCall!);
  assert.ok(script.includes('claude'), 'must spawn claude');
  assert.ok(script.includes('--session-id'), 'first-time spawn uses --session-id');
  assert.ok(script.includes('sid-aaaa-bbbb'));
  // Jsonl tail attached
  assert.equal(tails.length, 1, 'one jsonl tail per session');
  assert.equal(tails[0].started, true);

  // Resolve turn so we don't leak the pending promise
  tails[0].finishTurn();
  await turnPromise;
});

test('first sendMessage with needsResume=true uses --resume instead of --session-id', async (t) => {
  const { deps, tmuxCalls, tails } = makeDeps();
  const sess = makeSession(deps, { needsResume: true });
  t.onTestFinished(() => { sess.kill(); });

  const turnPromise = sess.sendMessage('hi', {});
  await new Promise(r => setImmediate(r));

  const newSessCall = tmuxCalls.find(c => c.args[0] === 'new-session');
  const script = launcherScriptFor(newSessCall!);
  assert.ok(script.includes('--resume'));
  assert.ok(!script.includes('--session-id'));

  tails[0].finishTurn();
  await turnPromise;
});

test('sendMessage pastes the prompt text and submits with Enter', async (t) => {
  const { deps, tmuxCalls, tails } = makeDeps();
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  const turnPromise = sess.sendMessage('my prompt here', {});
  await new Promise(r => setImmediate(r));

  // load-buffer + paste-buffer + send-keys Enter must all occur after new-session
  const opsAfterSpawn = tmuxCalls.slice(tmuxCalls.findIndex(c => c.args[0] === 'new-session') + 1);
  const hasLoadBuffer = opsAfterSpawn.some(c => c.args[0] === 'load-buffer');
  const hasPasteBuffer = opsAfterSpawn.some(c => c.args[0] === 'paste-buffer');
  const hasEnterKey = opsAfterSpawn.some(c => c.args[0] === 'send-keys' && c.args.includes('Enter'));
  assert.ok(hasLoadBuffer, 'load-buffer (write tmpfile -> tmux buffer) must run');
  assert.ok(hasPasteBuffer, 'paste-buffer must run');
  assert.ok(hasEnterKey, 'Enter must be sent to submit the prompt');

  tails[0].finishTurn();
  await turnPromise;
});

test('sendMessage delays Enter after paste so the Ink TUI registers the bracketed paste', async (t) => {
  // Regression: an Enter sent immediately after paste-buffer is swallowed by Claude's Ink TUI and
  // the prompt never submits (no jsonl is ever written). A settle delay between paste and Enter is
  // required. Here we assert Enter is NOT sent within the delay window, then IS after it elapses.
  const { exec, calls } = makeRecordingExec();
  const tails: MockTail[] = [];
  const deps: TuiSessionDeps = {
    tmux: new TmuxControl(exec),
    tailFactory: (path: string) => { const tl = new MockTail(path); tails.push(tl); return tl as any; },
    waitForJsonlMs: 0,
    pasteSubmitDelayMs: 80,
    paneReadyTimeoutMs: 0,
  };
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  const turnPromise = sess.sendMessage('hi', {});
  await new Promise(r => setImmediate(r));
  const enterCount = () => calls.filter(c => c.args[0] === 'send-keys' && c.args.includes('Enter')).length;
  assert.ok(calls.some(c => c.args[0] === 'paste-buffer'), 'paste-buffer must have run');
  assert.equal(enterCount(), 0, 'Enter must NOT be sent during the paste-settle delay');

  await new Promise(r => setTimeout(r, 140));
  assert.equal(enterCount(), 1, 'Enter must be sent after the paste-settle delay elapses');

  tails[0].finishTurn();
  await turnPromise;
});

// =====================================================================================
//  Turn completion + AgentResult shape
// =====================================================================================

test('turn resolves with sessionId / num_turns / total_cost_usd populated from cost_record', async (t) => {
  const { deps, tails } = makeDeps();
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  const turnPromise = sess.sendMessage('hi', {});
  await new Promise(r => setImmediate(r));

  const tail = tails[0];
  tail.push({
    type: 'assistant',
    message: {
      id: 'msg_1', model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: 'final answer' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  });
  tail.finishTurn(1500);

  const result = await turnPromise;
  assert.equal(result.sessionId, 'sid-aaaa-bbbb');
  assert.equal(result.num_turns, 1);
  // sonnet: 100*$3/M + 50*$15/M = $0.00075
  assert.ok(result.total_cost_usd !== null);
  assert.ok(Math.abs(result.total_cost_usd! - (100 * 3e-6 + 50 * 15e-6)) < 1e-9);
  assert.equal(result.finalOutput, 'final answer');
});

test('turn aggregates multiple assistant messages — finalOutput is the last text block', async (t) => {
  const { deps, tails } = makeDeps();
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  const turnPromise = sess.sendMessage('hi', {});
  await new Promise(r => setImmediate(r));
  const tail = tails[0];

  tail.push({
    type: 'assistant',
    message: { id: 'm1', model: 'claude-sonnet-4-5-x', content: [{ type: 'text', text: 'first reasoning bit' }], usage: { input_tokens: 10, output_tokens: 5 } },
  });
  tail.push({
    type: 'assistant',
    message: { id: 'm2', model: 'claude-sonnet-4-5-x', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 10, output_tokens: 5 } },
  });
  tail.push({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'output', is_error: false }] },
  });
  tail.push({
    type: 'assistant',
    message: { id: 'm3', model: 'claude-sonnet-4-5-x', content: [{ type: 'text', text: 'wrap-up answer' }], usage: { input_tokens: 10, output_tokens: 5 } },
  });
  tail.finishTurn();

  const result = await turnPromise;
  assert.equal(result.finalOutput, 'wrap-up answer');
  assert.equal(result.num_turns, 3);
});

// =====================================================================================
//  Callback dispatch
// =====================================================================================

test('onAssistantMessage / onToolUse / onProgress callbacks fire per event', async (t) => {
  const { deps, tails } = makeDeps();
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  const messages: string[] = [];
  const tools: Array<{ name: string; input: any }> = [];
  const progress: number[] = [];

  const turnPromise = sess.sendMessage('hi', {
    onAssistantMessage: (text) => messages.push(text),
    onToolUse: (name, input) => tools.push({ name, input }),
    onProgress: (p) => progress.push(p.num_turns),
  });
  await new Promise(r => setImmediate(r));
  const tail = tails[0];

  tail.push({
    type: 'assistant',
    message: { id: 'm1', model: 'claude-sonnet-4-5-x', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'pwd' } }], usage: { input_tokens: 1, output_tokens: 1 } },
  });
  tail.push({
    type: 'assistant',
    message: { id: 'm2', model: 'claude-sonnet-4-5-x', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } },
  });
  tail.finishTurn();
  await turnPromise;

  assert.deepEqual(messages, ['done']);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'Bash');
  assert.deepEqual(tools[0].input, { command: 'pwd' });
  // Progress fires once per new message
  assert.deepEqual(progress, [1, 2]);
});

// =====================================================================================
//  Plan tracking + ask_user collection
// =====================================================================================

test('result carries enteredPlanMode + planFilePath when plan tools observed', async (t) => {
  const { deps, tails } = makeDeps();
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  const turnPromise = sess.sendMessage('plan something', {});
  await new Promise(r => setImmediate(r));
  const tail = tails[0];

  tail.push({
    type: 'assistant',
    message: { id: 'm1', model: 'claude-sonnet-4-5-x', content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__cortex-tui-bridge__cortex_plan_enter', input: { reasoning: '...' } }], usage: { input_tokens: 1, output_tokens: 1 } },
  });
  tail.push({
    type: 'assistant',
    message: { id: 'm2', model: 'claude-sonnet-4-5-x', content: [{ type: 'tool_use', id: 'tu_2', name: 'Write', input: { file_path: '/home/x/plan/foo.md', content: 'plan body' } }], usage: { input_tokens: 1, output_tokens: 1 } },
  });
  tail.finishTurn();

  const result = await turnPromise;
  assert.equal(result.enteredPlanMode, true);
  assert.equal(result.planFilePath, '/home/x/plan/foo.md');
});

test('result does NOT collect askUserQuestions from self-resolving MCP cortex_ask_user (no re-post)', async (t) => {
  // cortex_ask_user posts + blocks + collects the answer through its own webhook within the turn,
  // so the turn result must NOT carry askUserQuestions — otherwise lifecycle.sendMessages re-posts
  // the already-answered question (the stray Slack cards). The invocation still surfaces as a
  // tool_use via onToolUse for the tool trace.
  const { deps, tails } = makeDeps();
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  const tools: Array<{ name: string }> = [];
  const turnPromise = sess.sendMessage('ask me', { onToolUse: (name) => tools.push({ name }) });
  await new Promise(r => setImmediate(r));
  const tail = tails[0];

  tail.push({
    type: 'assistant',
    message: { id: 'm1', model: 'claude-sonnet-4-5-x', content: [{
      type: 'tool_use', id: 'tu_1', name: 'mcp__cortex-tui-bridge__cortex_ask_user',
      input: {
        questions: [
          { question: 'Pick one', header: 'choice', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
          { question: 'Free text', options: [] },
        ],
      },
    }], usage: { input_tokens: 1, output_tokens: 1 } },
  });
  tail.finishTurn();

  const result = await turnPromise;
  assert.equal(result.askUserQuestions.length, 0);
  assert.deepEqual(tools.map(x => x.name), ['mcp__cortex-tui-bridge__cortex_ask_user']);
});

// =====================================================================================
//  cancel
// =====================================================================================

test('cancelCurrentTurn sends Escape then C-u then rejects pending turn', async (t) => {
  const { deps, tmuxCalls, tails } = makeDeps();
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  const turnPromise = sess.sendMessage('long task', {});
  await new Promise(r => setImmediate(r));

  // sanity: turn is in flight
  const cancelPromise = sess.cancelCurrentTurn();
  await cancelPromise;

  const cancelOps = tmuxCalls.filter(c => c.args[0] === 'send-keys' && (c.args.includes('Escape') || c.args.includes('C-u')));
  assert.ok(cancelOps.some(c => c.args.includes('Escape')), 'cancel must send Escape');
  assert.ok(cancelOps.some(c => c.args.includes('C-u')), 'cancel must send C-u to clear buffer');

  await assert.rejects(turnPromise, /cancel/i);
  void tails;
});

test('cancelCurrentTurn is a no-op when no turn is in flight', async (t) => {
  const { deps } = makeDeps();
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  // Spawn-then-await a clean turn first
  const p = sess.sendMessage('x', {});
  await new Promise(r => setImmediate(r));
  const { tails } = ((): any => ({ tails: (deps.tailFactory as any).__tails }))();
  // Use the deps closure tail reference via re-construction is tricky; easier: use the session directly.
  await sess.cancelCurrentTurn(); // turn IS in flight here, will reject
  await assert.rejects(p);
  // Now no turn — cancel should not throw
  await sess.cancelCurrentTurn();
});

// =====================================================================================
//  kill / close
// =====================================================================================

test('kill() invokes tmux kill-session and rejects pending turns', async (t) => {
  const { deps, tmuxCalls } = makeDeps();
  const sess = makeSession(deps);

  const turnPromise = sess.sendMessage('x', {});
  await new Promise(r => setImmediate(r));

  sess.kill();
  const killCall = tmuxCalls.find(c => c.args[0] === 'kill-session');
  assert.ok(killCall, 'kill must invoke tmux kill-session');
  await assert.rejects(turnPromise);
});

test('isAlive() reflects spawn + kill lifecycle', async (t) => {
  const { deps, tails } = makeDeps();
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  assert.equal(sess.isAlive(), false, 'not alive before first spawn');
  const turnPromise = sess.sendMessage('x', {});
  await new Promise(r => setImmediate(r));
  assert.equal(sess.isAlive(), true, 'alive after spawn');
  tails[0].finishTurn();
  await turnPromise;
  assert.equal(sess.isAlive(), true, 'still alive between turns');
  sess.kill();
  assert.equal(sess.isAlive(), false, 'dead after kill');
});

// =====================================================================================
//  Multi-turn cost accumulation across turns
// =====================================================================================

test('cumulative cost accumulates correctly across multiple sequential turns', async (t) => {
  const { deps, tails } = makeDeps();
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  // Turn 1
  const p1 = sess.sendMessage('q1', {});
  await new Promise(r => setImmediate(r));
  tails[0].push({
    type: 'assistant',
    message: { id: 'm1', model: 'claude-sonnet-4-5-x', content: [{ type: 'text', text: 'a1' }], usage: { input_tokens: 100, output_tokens: 50 } },
  });
  tails[0].finishTurn();
  const r1 = await p1;
  // Per-turn cost = 100*3e-6 + 50*15e-6
  const expectedT1 = 100 * 3e-6 + 50 * 15e-6;
  assert.ok(Math.abs(r1.total_cost_usd! - expectedT1) < 1e-9);

  // Turn 2 — uses the same session, no re-spawn
  const p2 = sess.sendMessage('q2', {});
  await new Promise(r => setImmediate(r));
  tails[0].push({
    type: 'assistant',
    message: { id: 'm2', model: 'claude-sonnet-4-5-x', content: [{ type: 'text', text: 'a2' }], usage: { input_tokens: 200, output_tokens: 100 } },
  });
  tails[0].finishTurn();
  const r2 = await p2;
  // Turn 2's per-turn cost only (not cumulative — matches -p adapter behavior)
  const expectedT2 = 200 * 3e-6 + 100 * 15e-6;
  assert.ok(Math.abs(r2.total_cost_usd! - expectedT2) < 1e-9, `expected ${expectedT2}, got ${r2.total_cost_usd}`);

  // Single tmux session for both turns
  assert.equal(tails.length, 1, 'session reuses tmux + tail across turns');
});

// =====================================================================================
//  jsonl path computation
// =====================================================================================

// =====================================================================================
//  onEvent stream + resume recovery (DR-0012 Phase 4 prerequisites)
// =====================================================================================

test('onEvent callback fires for every NormalizedEvent including turn_complete', async (t) => {
  const { deps, tails } = makeDeps();
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  const events: any[] = [];
  const turnPromise = sess.sendMessage('hi', { onEvent: (ev) => events.push(ev) });
  await new Promise(r => setImmediate(r));
  const tail = tails[0];

  tail.push({
    type: 'assistant',
    message: { id: 'm1', model: 'claude-sonnet-4-5-x', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 1, output_tokens: 1 } },
  });
  tail.push({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'output', is_error: false }] },
  });
  tail.push({
    type: 'assistant',
    message: { id: 'm2', model: 'claude-sonnet-4-5-x', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } },
  });
  tail.finishTurn();
  await turnPromise;

  // Must include tool_use, tool_result, assistant_text, turn_progress, cost_record, turn_complete
  const types = events.map(e => e.type);
  assert.ok(types.includes('tool_use'), `missing tool_use in: ${types.join(',')}`);
  assert.ok(types.includes('tool_result'), `missing tool_result in: ${types.join(',')}`);
  assert.ok(types.includes('assistant_text'));
  assert.ok(types.includes('turn_progress'));
  assert.ok(types.includes('cost_record'));
  assert.ok(types.includes('turn_complete'));
});

test('when tmux dies between turns, second sendMessage re-spawns with --resume', async (t) => {
  const { deps, tmuxCalls, tails } = makeDeps();
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  // Turn 1: fresh spawn → --session-id
  const p1 = sess.sendMessage('q1', {});
  await new Promise(r => setImmediate(r));
  const newSess1 = tmuxCalls.find(c => c.args[0] === 'new-session');
  assert.ok(launcherScriptFor(newSess1!).includes('--session-id'), 'turn 1 must use --session-id');
  tails[0].finishTurn();
  await p1;

  // Simulate tmux session getting killed externally — kill via the same TmuxControl
  sess['tmux'].killSession(sess.tmuxName);
  // The mock has-session for this name should now return non-zero (kill recorded)
  // (Our recording exec marks created+killed → not alive)

  // Turn 2: must re-spawn — and must use --resume since the jsonl session exists
  const p2 = sess.sendMessage('q2', {});
  await new Promise(r => setImmediate(r));
  const newSessCalls = tmuxCalls.filter(c => c.args[0] === 'new-session');
  assert.equal(newSessCalls.length, 2, 'must spawn again after tmux died');
  assert.ok(launcherScriptFor(newSessCalls[1]).includes('--resume'), 'recovery spawn must use --resume, not --session-id');

  tails[tails.length - 1].finishTurn();
  await p2;
});

test('jsonl path follows ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl convention', async (t) => {
  const { deps, tails } = makeDeps();
  const sess = makeSession(deps, { cwd: '/home/foo/Cortex' });
  t.onTestFinished(() => { sess.kill(); });

  const p = sess.sendMessage('x', {});
  await new Promise(r => setImmediate(r));

  assert.equal(tails.length, 1);
  // Encoded cwd: leading slash becomes leading dash, then dashes for each /
  assert.match(tails[0].path, /\/home\/.*\/\.claude\/projects\/-home-foo-Cortex\/sid-aaaa-bbbb\.jsonl$/);

  tails[0].finishTurn();
  await p;
});

test('jsonl path encodes BOTH slashes AND dots in cwd (regression: DATA_DIR /home/x/.cortex)', async (t) => {
  // Claude itself encodes `.` as `-` in its `~/.claude/projects/` directory layout.
  // Without this rule, sessions running under the default DATA_DIR (~/.cortex) would
  // watch a non-existent jsonl path and time out on first turn.
  const { deps, tails } = makeDeps();
  const sess = makeSession(deps, { cwd: '/home/foo/.cortex' });
  t.onTestFinished(() => { sess.kill(); });

  const p = sess.sendMessage('x', {});
  await new Promise(r => setImmediate(r));

  assert.equal(tails.length, 1);
  // Note: `--cortex` (double dash) — leading `/` AND `.` both became dashes.
  assert.match(tails[0].path, /\/home\/.*\/\.claude\/projects\/-home-foo--cortex\/sid-aaaa-bbbb\.jsonl$/);

  tails[0].finishTurn();
  await p;
});

test('first-turn tail.start() failure does not wedge the session — next sendMessage kills the orphan tmux session and respawns', async (t) => {
  // Regression for the "duplicate session" crash: if the first ensureSpawned() throws AFTER
  // tmux new-session already created the session (e.g. tail.start() rejected), `alive` stays false
  // but the tmux session is live. The next sendMessage must kill that orphan before new-session,
  // otherwise tmux fails with "duplicate session" and the session is permanently wedged.
  const { exec, calls: tmuxCalls } = makeRecordingExec();
  const tails: MockTail[] = [];
  let startCount = 0;
  const deps: TuiSessionDeps = {
    tmux: new TmuxControl(exec),
    tailFactory: (path: string) => {
      const tail = new MockTail(path);
      // Make ONLY the first tail's start() reject (simulates jsonl never appearing on turn 1).
      const idx = startCount;
      tail.start = async () => {
        startCount++;
        if (idx === 0) throw new Error('jsonl-tail: simulated first-turn start failure');
        tail.started = true; tail.startCalls++;
      };
      tails.push(tail);
      return tail as any;
    },
    waitForJsonlMs: 0,
    pasteSubmitDelayMs: 0,
    paneReadyTimeoutMs: 0,
  };
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  // Turn 1: ensureSpawned throws because the (first) tail.start rejects.
  await assert.rejects(sess.sendMessage('q1', {}), /simulated first-turn start failure/);
  const newSessAfterT1 = tmuxCalls.filter(c => c.args[0] === 'new-session');
  assert.equal(newSessAfterT1.length, 1, 'turn 1 created the tmux session before failing');

  // Turn 2: must kill the orphan (hasSession true, alive false) then new-session again, and resolve.
  const p2 = sess.sendMessage('q2', {});
  await new Promise(r => setImmediate(r));
  const newSessCalls = tmuxCalls.filter(c => c.args[0] === 'new-session');
  assert.equal(newSessCalls.length, 2, 'turn 2 must respawn after the wedged first turn');
  const killIdx = tmuxCalls.findIndex(c => c.args[0] === 'kill-session');
  const secondNewIdx = tmuxCalls.map(c => c.args[0]).lastIndexOf('new-session');
  assert.ok(killIdx !== -1 && killIdx < secondNewIdx, 'orphan tmux session must be killed before the second new-session');
  assert.ok(launcherScriptFor(newSessCalls[1]).includes('--resume'), 'respawn after first-spawn must use --resume (jsonl persists)');

  tails[tails.length - 1].finishTurn();
  await p2;
});

test('first-event watchdog rejects the turn when no jsonl output arrives within the timeout', async (t) => {
  const { exec } = makeRecordingExec();
  const tails: MockTail[] = [];
  const deps: TuiSessionDeps = {
    tmux: new TmuxControl(exec),
    tailFactory: (path: string) => { const tl = new MockTail(path); tails.push(tl); return tl as any; },
    waitForJsonlMs: 0,
    pasteSubmitDelayMs: 0,
    paneReadyTimeoutMs: 0,
    firstEventTimeoutMs: 60, // tiny fast-fail window for the test
  };
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  // Spawn + paste happen, but we never push any jsonl event → watchdog must fire.
  // The watchdog timer is unref()'d, so hold the loop open with a normal timer while it fires.
  const turnPromise = sess.sendMessage('hi', {});
  let rejection: Error | null = null;
  turnPromise.catch((e) => { rejection = e; });
  await new Promise(r => setTimeout(r, 150));
  assert.ok(rejection, 'turn must reject when no jsonl output arrives');
  assert.match((rejection as unknown as Error).message, /no jsonl output/i);
  // Session was killed by the watchdog.
  assert.equal(sess.isAlive(), false);
});

test('first-event watchdog is disarmed once the first jsonl event arrives', async (t) => {
  const { deps, tails } = makeDeps();
  (deps as any).firstEventTimeoutMs = 80;
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  const turnPromise = sess.sendMessage('hi', {});
  await new Promise(r => setImmediate(r));
  // First event arrives before the 80ms watchdog → it must NOT fire.
  tails[0].push({
    type: 'assistant',
    message: { id: 'm1', model: 'claude-sonnet-4-5-x', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
  });
  await new Promise(r => setTimeout(r, 120)); // exceed the watchdog window
  assert.equal(sess.isAlive(), true, 'watchdog must not kill after first event');
  tails[0].finishTurn();
  const result = await turnPromise;
  assert.equal(result.finalOutput, 'ok');
});

test('respawn after external tmux death stops the previous jsonl tail (no double-emit leak)', async (t) => {
  const { deps, tails } = makeDeps();
  const sess = makeSession(deps);
  t.onTestFinished(() => { sess.kill(); });

  // Turn 1: spawn + finish
  const p1 = sess.sendMessage('q1', {});
  await new Promise(r => setImmediate(r));
  assert.equal(tails.length, 1);
  const firstTail = tails[0];
  firstTail.finishTurn();
  await p1;
  assert.equal(firstTail.stopCalls, 0, 'between turns the tail stays alive — same tmux session');

  // External kill — same as `tmux kill-session` from a shell
  sess['tmux'].killSession(sess.tmuxName);

  // Turn 2: re-spawn must STOP the previous tail before constructing a new one,
  // otherwise the old poll timer keeps running and double-emits events.
  const p2 = sess.sendMessage('q2', {});
  await new Promise(r => setImmediate(r));
  assert.equal(tails.length, 2, 'a fresh tail must be constructed after respawn');
  assert.equal(firstTail.stopCalls, 1, 'previous tail must have been stopped exactly once');
  tails[1].finishTurn();
  await p2;
});
