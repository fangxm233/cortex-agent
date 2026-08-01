// input:  PI adapter hooks and fake subprocesses
// output: PI spawn, events, context, compact regressions
// pos:    Covers PI process and event lifecycle
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import { encodeCommand, createLineSplitter } from '../src/agent-adapter/pi/framing.js';
import { buildPiEnv, buildSpawnArgs } from '../src/agent-adapter/pi/spawn-args.js';
import { CAPABILITIES_BY_BACKEND } from '../src/agent-adapter/capabilities.js';

// Writable temp session dir used by Group G tests (avoids root-level paths that fail with EACCES).
const G_SESSION_DIR = pathJoin(tmpdir(), `pi-test-sessions-${process.pid}`);
mkdirSync(G_SESSION_DIR, { recursive: true });

// --- Stub child process infrastructure ---

interface StubChild extends EventEmitter {
  stdin: PassThrough & { writeHistory: string[] };
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  __killed: boolean;
  __lastSignal: string | null;
}

function makeStubChild(): StubChild {
  const emitter = new EventEmitter() as StubChild;
  const stdin = new PassThrough() as PassThrough & { writeHistory: string[] };
  stdin.writeHistory = [];
  const origWrite = stdin.write.bind(stdin);
  (stdin as any).write = (chunk: unknown, ...rest: unknown[]) => {
    const s = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
    stdin.writeHistory.push(s);
    return origWrite(chunk as any, ...(rest as any));
  };
  emitter.stdin = stdin;
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.__killed = false;
  emitter.__lastSignal = null;
  emitter.kill = (signal?: NodeJS.Signals | number) => {
    if (emitter.__killed) return false;
    emitter.__killed = true;
    emitter.__lastSignal = typeof signal === 'string' ? signal : signal !== undefined ? String(signal) : 'SIGTERM';
    return true;
  };
  return emitter;
}

function makeStubSpawner(): {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  calls: { cmd: string; args: string[]; opts: SpawnOptions }[];
  children: StubChild[];
} {
  const calls: { cmd: string; args: string[]; opts: SpawnOptions }[] = [];
  const children: StubChild[] = [];
  return {
    calls,
    children,
    spawn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const child = makeStubChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
  };
}

test('spawn accepts explicit direct and thread-control MCP compositions', () => {
  for (const composition of ['direct', 'thread-control'] as const) {
    const stub = makeStubSpawner();
    const adapter = new PIAdapter(stub.spawn);
    const proc = adapter.spawn({
      sessionId: null,
      sessionKey: `pi-${composition}`,
      resume: false,
      mcpComposition: composition,
    });

    assert.equal(stub.calls.length, 1, `${composition} must reach the spawn boundary`);
    proc.kill();
    stub.children[0].emit('close', 0);
  }
});

// --- Group A: framing correctness (done-when: NDJSON LF-only framing) ---

test('encodeCommand produces byte-exact JSONL with single LF delimiter', () => {
  const out = encodeCommand({ id: 'r1', type: 'get_state' });
  assert.equal(out, '{"id":"r1","type":"get_state"}\n');
  assert.equal(out[out.length - 1], '\n');
  assert.ok(!out.includes('\r'));
});

test('encodeCommand escapes internal newlines inside JSON string values', () => {
  // JSON.stringify escapes embedded \n → "\\n"; there must be exactly one raw LF (the trailing delimiter).
  const out = encodeCommand({ msg: 'line1\nline2' });
  assert.equal((out.match(/\n/g) ?? []).length, 1, 'only one raw LF (the trailing delimiter)');
  assert.ok(out.includes('line1\\nline2'));
});

test('createLineSplitter splits LF-only, strips trailing CR, buffers across chunks', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('a\nb\r\nc'), ['a', 'b']);
  assert.deepEqual(s.push('d\n'), ['cd']);
  assert.equal(s.flushRemainder(), null);
});

test('createLineSplitter handles multiple lines in one chunk and empty tail', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('one\ntwo\nthree\n'), ['one', 'two', 'three']);
  assert.equal(s.flushRemainder(), null);
});

test('createLineSplitter flushRemainder returns partial tail line', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('complete\npartial'), ['complete']);
  assert.equal(s.flushRemainder(), 'partial');
  assert.equal(s.flushRemainder(), null, 'second flush returns null');
});

// --- Group B: spawn args (done-when: --mode rpc + --session-dir + pluginDirs(--skill)) ---

test('buildSpawnArgs baseline: only sessionDir produces mode/rpc/session-dir', () => {
  assert.deepEqual(buildSpawnArgs({ sessionDir: '/x' }), ['--mode', 'rpc', '--session-dir', '/x']);
});

test('buildSpawnArgs full options snapshot with multiple pluginDirs in order', () => {
  const args = buildSpawnArgs({
    sessionDir: '/pi-sessions',
    systemPrompt: 'sp',
    appendSystemPrompt: 'asp',
    pluginDirs: ['/a', '/b'],
  });
  assert.deepEqual(args, [
    '--mode', 'rpc',
    '--session-dir', '/pi-sessions',
    '--system-prompt', 'sp',
    '--append-system-prompt', 'asp',
    '--skill', '/a',
    '--skill', '/b',
  ]);
});

test('buildSpawnArgs accepts appendSystemPrompt array for repeated flag', () => {
  const args = buildSpawnArgs({
    sessionDir: '/x',
    appendSystemPrompt: ['one', 'two'],
  });
  assert.deepEqual(args, [
    '--mode', 'rpc',
    '--session-dir', '/x',
    '--append-system-prompt', 'one',
    '--append-system-prompt', 'two',
  ]);
});

test('buildSpawnArgs: thinking level is passed as --thinking', () => {
  const args = buildSpawnArgs({ sessionDir: '/x', thinking: 'high' });
  const idx = args.indexOf('--thinking');
  assert.ok(idx >= 0, '--thinking must be present');
  assert.equal(args[idx + 1], 'high');
});

test('buildSpawnArgs: no --thinking when thinking is absent (backward compat)', () => {
  assert.ok(!buildSpawnArgs({ sessionDir: '/x' }).includes('--thinking'));
  assert.ok(!buildSpawnArgs({ sessionDir: '/x', thinking: null }).includes('--thinking'));
});

test('buildSpawnArgs emits no --skill when pluginDirs is empty or undefined', () => {
  const a = buildSpawnArgs({ sessionDir: '/x', pluginDirs: [] });
  assert.ok(!a.includes('--skill'));
  const b = buildSpawnArgs({ sessionDir: '/x' });
  assert.ok(!b.includes('--skill'));
});

// --- Group B2: PI subprocess context env ---

test('spawn forwards authoritative Cortex thread context to the PI subprocess', () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn);
  const proc = adapter.spawn({
    sessionId: 'backend-session',
    sessionKey: 'context-env',
    resume: false,
    callbackSource: 'thread',
    scheduleTaskId: 'schedule-1',
    env: { CORTEX_THREAD_ID: 'spoofed', CUSTOM_ENV: 'kept' },
    cortexContext: {
      threadId: 'thr_test',
      profile: 'deepseek-pro',
      project: 'vr-security',
      sessionName: 'cortex-test',
      trackSessionId: 'tracked-session',
      executionId: 'exec-test',
      threadDepth: 2,
      taskId: 'ab1a',
      taskProject: 'vr-security',
    },
  });

  const env = stub.calls[0].opts.env as NodeJS.ProcessEnv;
  assert.equal(env.CORTEX_THREAD_ID, 'thr_test');
  assert.equal(env.CORTEX_PROFILE, 'deepseek-pro');
  assert.equal(env.CORTEX_PROJECT, 'vr-security');
  assert.equal(env.CORTEX_SESSION_NAME, 'cortex-test');
  assert.equal(env.CORTEX_SESSION_ID, 'tracked-session');
  assert.equal(env.CORTEX_EXECUTION_ID, 'exec-test');
  assert.equal(env.CORTEX_THREAD_DEPTH, '2');
  assert.equal(env.CORTEX_TASK_ID, 'ab1a');
  assert.equal(env.CORTEX_TASK_PROJECT, 'vr-security');
  assert.equal(env.CORTEX_CALLBACK_SOURCE, 'thread');
  assert.equal(env.CORTEX_SCHEDULE_TASK_ID, 'schedule-1');
  assert.equal(env.CORTEX_BACKEND, 'pi');
  assert.equal(env.CUSTOM_ENV, 'kept');

  stub.children[0].emit('close', 0, null);
  void proc.close();
});

test('buildPiEnv removes stale optional Cortex context from the parent env', () => {
  const stale = {
    CORTEX_THREAD_ID: 'stale-thread',
    CORTEX_PROFILE: 'stale-profile',
    CORTEX_PROJECT: 'stale-project',
    CORTEX_SESSION_NAME: 'stale-name',
    CORTEX_EXECUTION_ID: 'stale-execution',
    CORTEX_THREAD_DEPTH: '9',
    CORTEX_TASK_ID: 'stale-task',
    CORTEX_TASK_PROJECT: 'stale-task-project',
    CORTEX_CALLBACK_SOURCE: 'stale-callback',
    CORTEX_SCHEDULE_TASK_ID: 'stale-schedule',
  };
  const env = buildPiEnv({
    sessionId: null,
    piAgentDir: '/pi-agent',
  }, stale);

  for (const key of Object.keys(stale)) assert.equal(env[key], undefined, key);
  assert.equal(env.CORTEX_SESSION_ID, undefined);
  assert.equal(env.CORTEX_BACKEND, 'pi');
  assert.equal(env.PI_CODING_AGENT_DIR, '/pi-agent');
});

// --- D1: --provider passed through from profile mode, not hardcoded ---

test('buildSpawnArgs: explicit provider opt is passed as --provider', () => {
  const args = buildSpawnArgs({ sessionDir: '/x', model: 'gpt-5.4-mini', provider: 'openai-codex' });
  const idx = args.indexOf('--provider');
  assert.ok(idx >= 0, '--provider must be present');
  assert.equal(args[idx + 1], 'openai-codex');
});

test('PIAdapter spawns an openai-codex provider profile through PI', () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn);
  const proc = adapter.spawn({
    sessionId: null,
    sessionKey: 'openai-codex-profile',
    resume: false,
    model: 'gpt-5.4-mini',
    piProvider: 'openai-codex',
  });

  assert.equal(stub.calls[0].cmd, 'pi');
  const providerIndex = stub.calls[0].args.indexOf('--provider');
  assert.ok(providerIndex >= 0, '--provider must be present');
  assert.equal(stub.calls[0].args[providerIndex + 1], 'openai-codex');
  stub.children[0].emit('close', 0, null);
  void proc.close();
});

test('buildSpawnArgs: provider opt is NOT defaulted to "anthropic" when only model given', () => {
  // Old behavior: always pushed --provider anthropic when model was set. New behavior: omit --provider.
  const args = buildSpawnArgs({ sessionDir: '/x', model: 'claude-opus-4-7' });
  assert.ok(!args.includes('--provider'),
    `--provider should not appear when not requested explicitly, got: ${JSON.stringify(args)}`);
});

test('buildSpawnArgs: provider is omitted when model is not set (no orphan flag)', () => {
  const args = buildSpawnArgs({ sessionDir: '/x', provider: 'deepseek' });
  // Without --model, --provider is meaningless; omit both
  assert.ok(!args.includes('--provider'));
  assert.ok(!args.includes('--model'));
});

// --- Group C: bootstrap id capture (done-when: first get_state synthesizes session_started) ---

test('spawn writes bootstrap {id:"bootstrap",type:"get_state"} as ONLY first stdin frame', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'k1', resume: false, pluginDirs: [] });

  // Allow synchronous constructor to enqueue writes — PassThrough buffers are synchronous.
  await Promise.resolve();

  const child = stub.children[0];
  assert.ok(child, 'stub spawner was called');
  // Nice-to-have #4 from Plan Review iter1: lock bootstrap-correlation invariant.
  assert.equal(child.stdin.writeHistory.length, 1, 'exactly one spawn-time write');
  assert.equal(
    child.stdin.writeHistory[0],
    '{"id":"bootstrap","type":"get_state"}\n',
    'byte-exact bootstrap frame with LF delimiter',
  );
  assert.equal(proc.sessionId, null, 'sessionId is null until response arrives');

  // clean up so test runner does not keep the stub stdin open
  child.emit('close', 0, null);
  await proc.close();
});

test('bootstrap response populates sessionId and emits session_started as first NormalizedEvent', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'k2', resume: false });

  await Promise.resolve();
  const child = stub.children[0];

  const eventsIter = proc.events[Symbol.asyncIterator]();
  const firstEventPromise = eventsIter.next();

  child.stdout.emit(
    'data',
    Buffer.from(
      '{"type":"response","id":"bootstrap","command":"get_state","success":true,"data":{"sessionId":"abc-123"}}\n',
    ),
  );

  const firstResult = await firstEventPromise;
  assert.equal(firstResult.done, false);
  assert.deepEqual(firstResult.value, { type: 'session_started', sessionId: 'abc-123' });
  assert.equal(proc.sessionId, 'abc-123', 'AgentProcess.sessionId getter reflects bootstrap fill-in');

  child.emit('close', 0, null);
  await proc.close();
});

test('bootstrap response with missing data.sessionId does not emit session_started', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'k3', resume: false });

  await Promise.resolve();
  const child = stub.children[0];

  child.stdout.emit(
    'data',
    Buffer.from('{"type":"response","id":"bootstrap","command":"get_state","success":true,"data":{}}\n'),
  );

  // session_started must NOT have been pushed; iterator should resolve only after close.
  assert.equal(proc.sessionId, null);

  child.emit('close', 0, null);
  const result = await proc.events[Symbol.asyncIterator]().next();
  assert.equal(result.done, true, 'iterator terminates without emitting session_started');
});

test('PI turn emits live context_usage during streaming without flushing partial text', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'context-live', resume: false });
  const child = stub.children[0];
  const iterator = proc.events[Symbol.asyncIterator]();

  emitBootstrap(child, 'context-live-session');
  await iterator.next();
  let turnSettled = false;
  const turn = proc.send({ text: 'hello' }).then((result) => { turnSettled = true; return result; });

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    type: 'message_update', message: { id: 'm-live' },
    assistantMessageEvent: { type: 'text_delta', delta: 'partial' },
  }) + '\n'));
  assert.deepEqual((await iterator.next()).value, {
    type: 'assistant_delta', text: 'partial', blockId: 'm-live',
  });

  const liveStats = child.stdin.writeHistory
    .map((frame) => JSON.parse(frame.trim()) as Record<string, unknown>)
    .find((command) => command.type === 'get_session_stats');
  assert.ok(liveStats, 'streaming output triggers a throttled stats query before settle');
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    type: 'response', id: liveStats.id, command: 'get_session_stats', success: true,
    data: { contextUsage: { tokens: 60100, contextWindow: 200000, percent: 30.05 } },
  }) + '\n'));

  assert.deepEqual((await iterator.next()).value, {
    type: 'context_usage', usedTokens: 60100, contextWindow: 200000,
    percent: 30.05, accuracy: 'estimate',
  });
  assert.equal(turnSettled, false, 'live context snapshot does not settle the turn');

  child.stdout.emit('data', Buffer.from('{"type":"message_end"}\n'));
  assert.deepEqual((await iterator.next()).value, {
    type: 'assistant_text', text: 'partial', blockId: 'm-live',
  });
  assert.equal((await iterator.next()).value.type, 'turn_progress');

  child.stdout.emit('data', Buffer.from('{"type":"agent_settled"}\n'));
  await turn;
  const finalStats = child.stdin.writeHistory
    .map((frame) => JSON.parse(frame.trim()) as Record<string, unknown>)
    .filter((command) => command.type === 'get_session_stats')
    .at(-1)!;
  assert.notEqual(finalStats.id, liveStats.id);
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    type: 'response', id: finalStats.id, command: 'get_session_stats', success: true,
    data: { contextUsage: { tokens: 60200, contextWindow: 200000, percent: 30.1 } },
  }) + '\n'));
  assert.equal((await iterator.next()).value.type, 'context_usage');
  assert.equal((await iterator.next()).value.type, 'turn_complete');

  child.emit('close', 0, null);
  await proc.close();
});

test('settled PI turn emits context_usage before its terminal event', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'context-order', resume: false });
  const child = stub.children[0];
  const iterator = proc.events[Symbol.asyncIterator]();

  emitBootstrap(child, 'context-session');
  assert.equal((await iterator.next()).value.type, 'session_started');

  const turn = proc.send({ text: 'hello' });
  child.stdout.emit('data', Buffer.from('{"type":"agent_settled"}\n'));
  await turn;

  const stats = child.stdin.writeHistory
    .map((frame) => JSON.parse(frame.trim()) as Record<string, unknown>)
    .find((command) => command.type === 'get_session_stats');
  assert.ok(stats, 'agent_settled sends one optional stats query');

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    type: 'response', id: stats.id, command: 'get_session_stats', success: true,
    data: { contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 } },
  }) + '\n'));

  assert.deepEqual((await iterator.next()).value, {
    type: 'context_usage', usedTokens: 60000, contextWindow: 200000,
    percent: 30, accuracy: 'estimate',
  });
  assert.deepEqual((await iterator.next()).value, {
    type: 'turn_complete', numTurns: 0, totalCostUsd: null,
  });
  let streamDone = false;
  void iterator.next().then((entry) => { streamDone = entry.done; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(streamDone, true, 'per-run stream closes after its terminal event');

  child.emit('close', 0, null);
  await proc.close();
});

// --- Group D: exit-on-stdin-close + adapter session map cleanup ---

test('close() ends stdin and resolves when child emits close', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'k4', resume: false });

  await Promise.resolve();
  const child = stub.children[0];

  let stdinEnded = false;
  child.stdin.on('end', () => { stdinEnded = true; });
  child.stdin.on('finish', () => { stdinEnded = true; });

  const closePromise = proc.close();
  // Simulate pi exiting cleanly on stdin close (FINDINGS.md §S1).
  setImmediate(() => child.emit('close', 0, null));
  await closePromise;

  assert.ok(stdinEnded, 'stdin.end() was invoked');
  assert.ok(!adapter.listSessions().includes('k4'), 'session removed from adapter map');
});

test('events iterator terminates with {done:true} after close', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'k5', resume: false });

  await Promise.resolve();
  const child = stub.children[0];

  child.emit('close', 0, null);
  await proc.close();

  const result = await proc.events[Symbol.asyncIterator]().next();
  assert.equal(result.done, true);
});

test('non-zero exit emits fatal error event before iterator terminates', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'k6', resume: false });

  await Promise.resolve();
  const child = stub.children[0];

  child.stderr.emit('data', Buffer.from('fatal: no API key'));
  child.emit('close', 1, null);

  const iter = proc.events[Symbol.asyncIterator]();
  const first = await iter.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.type, 'error');
  if (first.value?.type === 'error') {
    assert.equal(first.value.fatal, true);
    assert.ok(first.value.message.includes('fatal: no API key'));
  }
  const second = await iter.next();
  assert.equal(second.done, true);
});

test('kill() sends SIGTERM and cleans adapter session map', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'k7', resume: false });

  await Promise.resolve();
  const child = stub.children[0];

  const killed = proc.kill();
  assert.equal(killed, true);
  assert.equal(child.__lastSignal, 'SIGTERM');
  assert.ok(!adapter.listSessions().includes('k7'));

  child.emit('close', null, 'SIGTERM');
});

// --- Group E: adapter contract sanity ---

test('PIAdapter exposes backend=pi with frozen capability matrix', () => {
  const adapter = new PIAdapter();
  assert.equal(adapter.backend, 'pi');
  assert.equal(adapter.capabilities, CAPABILITIES_BY_BACKEND.pi);
});

// --- Group F: extensionPaths / --extension flag (task 5754 MCP bridge) ---

test('buildSpawnArgs emits --extension for each extensionPaths entry in order', () => {
  const args = buildSpawnArgs({
    sessionDir: '/s',
    extensionPaths: ['/ext/a.ts', '/ext/b.ts'],
  });
  assert.deepEqual(args, [
    '--mode', 'rpc',
    '--session-dir', '/s',
    '--extension', '/ext/a.ts',
    '--extension', '/ext/b.ts',
  ]);
});

test('buildSpawnArgs emits no --extension when extensionPaths is empty or undefined', () => {
  const a = buildSpawnArgs({ sessionDir: '/s', extensionPaths: [] });
  assert.ok(!a.includes('--extension'));
  const b = buildSpawnArgs({ sessionDir: '/s' });
  assert.ok(!b.includes('--extension'));
});

test('buildSpawnArgs places --extension after --skill when both are present', () => {
  const args = buildSpawnArgs({
    sessionDir: '/s',
    pluginDirs: ['/skill/dir'],
    extensionPaths: ['/ext/mcp.ts'],
  });
  const skillIdx = args.indexOf('--skill');
  const extIdx = args.indexOf('--extension');
  assert.ok(skillIdx !== -1, '--skill present');
  assert.ok(extIdx !== -1, '--extension present');
  assert.ok(skillIdx < extIdx, '--skill comes before --extension');
});

// --- Group G: session path mapping + switch_session runtime swap (task 7ca9) ---

// Helper: push a bootstrap response onto a stub child's stdout.
function emitBootstrap(child: StubChild, sessionId: string): void {
  child.stdout.emit(
    'data',
    Buffer.from(
      `{"type":"response","id":"bootstrap","command":"get_state","success":true,"data":{"sessionId":"${sessionId}"}}\n`,
    ),
  );
}

// Helper: push a switch_session response onto a stub child's stdout.
function emitSwitchResponse(child: StubChild, id: string, cancelled: boolean): void {
  child.stdout.emit(
    'data',
    Buffer.from(
      JSON.stringify({ type: 'response', command: 'switch_session', id, success: true, data: { cancelled } }) + '\n',
    ),
  );
}

// Helper: extract the most recent switch_session command written to stdin.
function lastSwitchCmd(child: StubChild): { id: string; sessionPath: string } | null {
  for (let i = child.stdin.writeHistory.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(child.stdin.writeHistory[i].trim()) as Record<string, unknown>;
      if (obj['type'] === 'switch_session') {
        return { id: obj['id'] as string, sessionPath: obj['sessionPath'] as string };
      }
    } catch { /* skip */ }
  }
  return null;
}

test('G-1: spawn + bootstrap → resolveSessionPath returns derived path for the bootstrapped sessionId', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn, G_SESSION_DIR);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'k1', resume: false });

  await Promise.resolve();
  const child = stub.children[0];

  // Before bootstrap: path is unknown.
  assert.equal(adapter.resolveSessionPath('abc-123'), null);

  emitBootstrap(child, 'abc-123');
  await Promise.resolve();

  // After bootstrap: path registered as <sessionDir>/<sessionId>.jsonl
  assert.equal(adapter.resolveSessionPath('abc-123'), pathJoin(G_SESSION_DIR, 'abc-123.jsonl'));
  assert.equal(proc.sessionId, 'abc-123');

  child.emit('close', 0, null);
  await proc.close();
});

test('G-2: resolveSessionPath on unknown sessionId returns null', () => {
  const adapter = new PIAdapter();
  assert.equal(adapter.resolveSessionPath('no-such-session'), null);
});

test('G-3: switchSession with unknown sessionId returns {ok:false, cancelled:false}', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn, G_SESSION_DIR);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'k1', resume: false });

  await Promise.resolve();
  const child = stub.children[0];
  emitBootstrap(child, 'abc-123');
  await Promise.resolve();

  // 'unknown-xyz' is not in registry → immediate {ok:false, cancelled:false}, no stdin write.
  const result = await adapter.switchSession('unknown-xyz', 'k1');
  assert.deepEqual(result, { ok: false, cancelled: false });

  child.emit('close', 0, null);
  await proc.close();
});

test('G-4: switchSession sends switch_session RPC and resolves with cancelled=false on success', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn, G_SESSION_DIR);
  const proc1 = adapter.spawn({ sessionId: null, sessionKey: 'k1', resume: false });
  const proc2 = adapter.spawn({ sessionId: null, sessionKey: 'k2', resume: false });

  await Promise.resolve();
  const child1 = stub.children[0];
  const child2 = stub.children[1];

  // Bootstrap both sessions.
  emitBootstrap(child1, 'abc-123');
  emitBootstrap(child2, 'xyz-456');
  await Promise.resolve();

  // Switch k1's subprocess to serve xyz-456.
  const switchPromise = adapter.switchSession('xyz-456', 'k1');

  // switch_session command should have been written to k1's stdin.
  const sw = lastSwitchCmd(child1);
  assert.ok(sw !== null, 'switch_session command written to k1 stdin');
  assert.equal(sw!.sessionPath, pathJoin(G_SESSION_DIR, 'xyz-456.jsonl'));

  // Respond with cancelled=false.
  emitSwitchResponse(child1, sw!.id, false);

  const result = await switchPromise;
  assert.deepEqual(result, { ok: true, cancelled: false });

  child1.emit('close', 0, null);
  child2.emit('close', 0, null);
  await proc1.close();
  await proc2.close();
});

test('G-5: switchSession propagates cancelled=true from switch_session response', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn, G_SESSION_DIR);
  const proc1 = adapter.spawn({ sessionId: null, sessionKey: 'k1', resume: false });
  const proc2 = adapter.spawn({ sessionId: null, sessionKey: 'k2', resume: false });

  await Promise.resolve();
  const child1 = stub.children[0];
  const child2 = stub.children[1];

  emitBootstrap(child1, 'abc-123');
  emitBootstrap(child2, 'xyz-456');
  await Promise.resolve();

  const switchPromise = adapter.switchSession('xyz-456', 'k1');
  const sw = lastSwitchCmd(child1);
  assert.ok(sw !== null);

  // Respond with cancelled=true (in-flight agent was preempted).
  emitSwitchResponse(child1, sw!.id, true);

  const result = await switchPromise;
  assert.deepEqual(result, { ok: true, cancelled: true });

  child1.emit('close', 0, null);
  child2.emit('close', 0, null);
  await proc1.close();
  await proc2.close();
});

test('G-6: sendTurn no-op when same session; auto-switches and writes prompt when different', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn, G_SESSION_DIR);
  const proc1 = adapter.spawn({ sessionId: null, sessionKey: 'k1', resume: false });
  const proc2 = adapter.spawn({ sessionId: null, sessionKey: 'k2', resume: false });

  await Promise.resolve();
  const child1 = stub.children[0];
  const child2 = stub.children[1];

  emitBootstrap(child1, 'abc-123');
  emitBootstrap(child2, 'xyz-456');
  await Promise.resolve();

  // --- no-op path: send to same session ---
  // proc1.send routes through sendTurn(abc-123, path, msg); currentSessionId=abc-123 → no switch.
  proc1.send({ text: 'hello' }).catch(() => {/* rejected promise expected */});
  await Promise.resolve();

  const histNoSwitch = child1.stdin.writeHistory.slice();
  // writeHistory: [bootstrap_frame, prompt_frame]
  assert.equal(histNoSwitch.length, 2, 'only bootstrap + prompt, no switch');
  assert.ok(!child1.stdin.writeHistory.join('').includes('switch_session'), 'no switch_session written');
  const promptNoSwitch = JSON.parse(histNoSwitch[1].trim()) as Record<string, unknown>;
  assert.equal(promptNoSwitch['type'], 'prompt');
  assert.equal(promptNoSwitch['message'], 'hello');

  // --- auto-switch path: divert k1 to xyz-456, then send ---
  const divertPromise = adapter.switchSession('xyz-456', 'k1');
  const swCmd = lastSwitchCmd(child1);
  assert.ok(swCmd !== null, 'switch_session command sent');
  emitSwitchResponse(child1, swCmd!.id, false);
  await divertPromise;
  // k1 currentSessionId is now xyz-456; spawn closure target is abc-123 → will auto-switch back.

  proc1.send({ text: 'auto-switch test' }).catch(() => {/* rejected promise expected */});
  // sendTurn is async (needs switch ack); wait a tick for the switch_session write.
  await Promise.resolve();

  const swBack = lastSwitchCmd(child1);
  assert.ok(swBack !== null, 'second switch_session command sent');
  assert.equal(swBack!.sessionPath, pathJoin(G_SESSION_DIR, 'abc-123.jsonl'), 'switches back to original session');

  // Respond to the switch-back.
  emitSwitchResponse(child1, swBack!.id, false);

  // Wait for sendTurn to complete and write the prompt.
  await new Promise(resolve => setImmediate(resolve));

  const finalHist = child1.stdin.writeHistory;
  const lastEntry = JSON.parse(finalHist[finalHist.length - 1].trim()) as Record<string, unknown>;
  assert.equal(lastEntry['type'], 'prompt', 'prompt written after switch-back');
  assert.equal(lastEntry['message'], 'auto-switch test');

  // Verify order: switch_session appears before the final prompt.
  const switchIdxBack = finalHist.findIndex((h, i) => i > 2 && h.includes('switch_session') && h.includes(swBack!.id));
  assert.ok(switchIdxBack < finalHist.length - 1, 'switch_session precedes prompt');

  child1.emit('close', 0, null);
  child2.emit('close', 0, null);
  await proc1.close();
  await proc2.close();
});

test('compact waits for bootstrap, sends correlated RPC, then returns post-compact stats', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn, G_SESSION_DIR);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'compact-ok', resume: false } as any);
  const child = stub.children[0];

  const compactPromise = proc.compact!();
  assert.equal(child.stdin.writeHistory.length, 1, 'bootstrap remains the only pre-ready frame');

  child.stdout.write(Buffer.from(
    '{"type":"response","id":"bootstrap","command":"get_state","success":true,"data":{"sessionId":"pi-compact"}}\n',
  ));
  await new Promise((resolve) => setImmediate(resolve));
  const compactFrame = JSON.parse(child.stdin.writeHistory[1].trim()) as Record<string, unknown>;
  assert.equal(compactFrame.type, 'compact');
  assert.equal(typeof compactFrame.id, 'string');

  child.stdout.write(Buffer.from(JSON.stringify({
    type: 'response', id: compactFrame.id, command: 'compact', success: true,
    data: {
      summary: 'short summary', tokensBefore: 120000, estimatedTokensAfter: 18000,
      usage: { input: 120000, output: 900, cacheRead: 10, cacheWrite: 20, cost: { total: 0.42 } },
    },
  }) + '\n'));
  await new Promise((resolve) => setImmediate(resolve));
  const statsFrame = JSON.parse(child.stdin.writeHistory[2].trim()) as Record<string, unknown>;
  assert.equal(statsFrame.type, 'get_session_stats');

  child.stdout.write(Buffer.from(JSON.stringify({
    type: 'response', id: statsFrame.id, command: 'get_session_stats', success: true,
    data: { contextUsage: { tokens: 19000, contextWindow: 200000, percent: 9.5 } },
  }) + '\n'));

  assert.deepEqual(await compactPromise, {
    status: 'compacted',
    tokensBefore: 120000,
    estimatedTokensAfter: 18000,
    contextUsage: { usedTokens: 19000, contextWindow: 200000, percent: 9.5, accuracy: 'estimate' },
    usage: { inputTokens: 120000, outputTokens: 900, cacheReadTokens: 10, cacheWriteTokens: 20, costUsd: 0.42 },
  });

  const close = proc.close();
  child.emit('close', 0);
  await close;
});

test('compact maps PI no-history response to not-needed without requesting stats', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn, G_SESSION_DIR);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'compact-empty', resume: false } as any);
  const child = stub.children[0];
  const compactPromise = proc.compact!();
  emitBootstrap(child, 'pi-empty');
  await new Promise((resolve) => setImmediate(resolve));
  const frame = JSON.parse(child.stdin.writeHistory[1].trim()) as Record<string, unknown>;
  child.stdout.write(Buffer.from(JSON.stringify({
    type: 'response', id: frame.id, command: 'compact', success: false,
    error: 'No messages to compact',
  }) + '\n'));

  assert.deepEqual(await compactPromise, {
    status: 'not-needed', tokensBefore: null, estimatedTokensAfter: null,
    contextUsage: null, usage: null,
  });
  assert.equal(child.stdin.writeHistory.length, 2);
  const close = proc.close();
  child.emit('close', 0);
  await close;
});

test('compact rejects a correlated PI failure response', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn, G_SESSION_DIR);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'compact-failed', resume: false } as any);
  const child = stub.children[0];
  const compactPromise = proc.compact!();
  emitBootstrap(child, 'pi-failed');
  await new Promise((resolve) => setImmediate(resolve));
  const frame = JSON.parse(child.stdin.writeHistory[1].trim()) as Record<string, unknown>;
  child.stdout.write(Buffer.from(JSON.stringify({
    type: 'response', id: frame.id, command: 'compact', success: false,
    error: 'compaction exploded',
  }) + '\n'));

  await assert.rejects(compactPromise, /compaction exploded/);
  const close = proc.close();
  child.emit('close', 0);
  await close;
});

test('compact rejects promptly when the PI subprocess exits', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn, G_SESSION_DIR);
  const proc = adapter.spawn({ sessionId: null, sessionKey: 'compact-exit', resume: false } as any);
  const child = stub.children[0];
  const compactPromise = proc.compact!();
  emitBootstrap(child, 'pi-exit');
  await new Promise((resolve) => setImmediate(resolve));
  child.emit('close', 17, null);

  await assert.rejects(compactPromise, /pi exited with code 17/i);
  await proc.close();
});

test('G-7: spawn with resume=true + known sessionId passes --session flag', async () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn, G_SESSION_DIR);

  // First spawn to register the session path.
  const proc1 = adapter.spawn({ sessionId: null, sessionKey: 'k1', resume: false });
  await Promise.resolve();
  emitBootstrap(stub.children[0], 'known-id');
  await Promise.resolve();
  stub.children[0].emit('close', 0, null);
  await proc1.close();

  assert.equal(adapter.resolveSessionPath('known-id'), pathJoin(G_SESSION_DIR, 'known-id.jsonl'));

  // Resume passes the already-known path so PI does not scan session bodies by id.
  adapter.spawn({ sessionId: 'known-id', sessionKey: 'k2', resume: true });
  const { args } = stub.calls[1];
  const sessionIdx = args.indexOf('--session');
  assert.ok(sessionIdx !== -1, '--session flag present');
  assert.equal(args[sessionIdx + 1], pathJoin(G_SESSION_DIR, 'known-id.jsonl'));

  stub.children[1].emit('close', 0, null);
});

test('G-8: spawn with resume=true but UNKNOWN sessionId omits --session (starts fresh)', () => {
  const stub = makeStubSpawner();
  const adapter = new PIAdapter(stub.spawn, G_SESSION_DIR);

  // PI can only RESUME an existing session (unlike Claude it cannot create one under an external
  // id). When the id is unknown — not bootstrapped in this adapter instance and no matching file in
  // --session-dir — the guard omits --session so PI bootstraps a fresh session instead of exiting
  // with "No session found matching <id>". (Regression: web/pi sessions minted a Cortex UUID and
  // forced resume, which PI rejected.)
  adapter.spawn({ sessionId: 'unknown-id', sessionKey: 'kR', resume: true });

  const { args } = stub.calls[0];
  assert.equal(args.indexOf('--session'), -1, '--session omitted for an unknown resume target');

  stub.children[0].emit('close', 0, null);
});

test('G-9: disk resume recognizes the exact timestamp-prefixed session filename', () => {
  const sessionDir = pathJoin(tmpdir(), `pi-resume-name-${process.pid}-${Date.now()}`);
  mkdirSync(sessionDir, { recursive: true });
  const sessionId = '01234567-89ab-7cde-8fab-0123456789ab';
  const sessionPath = pathJoin(sessionDir, `2026-08-01T01-02-03Z_${sessionId}.jsonl`);
  writeFileSync(sessionPath, 'not-json');

  try {
    const stub = makeStubSpawner();
    const adapter = new PIAdapter(stub.spawn, sessionDir);
    adapter.spawn({ sessionId, sessionKey: 'k-name', resume: true });

    const { args } = stub.calls[0];
    assert.equal(args[args.indexOf('--session') + 1], sessionPath);
    stub.children[0].emit('close', 0, null);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('G-10: disk resume does not discover an id only by reading an unrelated header', () => {
  const sessionDir = pathJoin(tmpdir(), `pi-resume-header-${process.pid}-${Date.now()}`);
  mkdirSync(sessionDir, { recursive: true });
  const sessionId = 'header-only-session';
  writeFileSync(pathJoin(sessionDir, 'unrelated-name.jsonl'), JSON.stringify({ type: 'session', id: sessionId }) + '\n');

  try {
    const stub = makeStubSpawner();
    const adapter = new PIAdapter(stub.spawn, sessionDir);
    adapter.spawn({ sessionId, sessionKey: 'k-header', resume: true });

    const { args } = stub.calls[0];
    assert.equal(args.indexOf('--session'), -1, 'resume discovery must not open unrelated bodies');
    stub.children[0].emit('close', 0, null);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});
