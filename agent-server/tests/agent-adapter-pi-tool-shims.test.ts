// input:  PIAdapter stub, retry/extension-ui events, tool shim gates
// output: PI shim and retry behavior through settled RPC turns
// pos:    PI pseudo-tool, retry, and extension-ui integration regression
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { mkdirSync } from 'node:fs';
import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import type { PIAgentProcess } from '../src/agent-adapter/pi/adapter.js';
import toolShims, { makeToolGate } from '../src/agent-adapter/pi/tool-shims.js';

const SESSION_DIR = pathJoin(tmpdir(), 'pi-shims-test-' + process.pid);
mkdirSync(SESSION_DIR, { recursive: true });

function makeStubChild(): any {
  const emitter = new EventEmitter() as any;
  const stdin = new PassThrough() as any;
  stdin.writeHistory = [] as string[];
  const origWrite = stdin.write.bind(stdin);
  stdin.write = (chunk: any, ...rest: any[]) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    stdin.writeHistory.push(s);
    return origWrite(chunk, ...rest);
  };
  emitter.stdin = stdin;
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.__killed = false;
  emitter.kill = () => { if (emitter.__killed) return false; emitter.__killed = true; return true; };
  return emitter;
}

function makeStubSpawner() {
  const children: any[] = [];
  return { children, spawn: () => { const c = makeStubChild(); children.push(c); return c; } };
}

function pushLine(child: any, obj: any) { child.stdout.write(JSON.stringify(obj) + '\n'); }

async function bootstrap(child: any, sessionId = 'sess-abc') {
  pushLine(child, { type: 'response', id: 'bootstrap', command: 'get_state', success: true, data: { sessionId } });
  await Promise.resolve();
}

// Tests A-D (same as before)
test('A: basic send', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k1', sessionId: null, resume: false });
  const child = s.children[0];
  await bootstrap(child);
  const turnPromise = proc.send({ text: 'hello' });
  pushLine(child, { type: 'agent_end', messages: [{ role: 'assistant', content: 'ok', usage: { cost: { total: 0.005 } } }] });
  pushLine(child, { type: 'agent_settled' });
  await Promise.resolve();
  const result = await turnPromise;
  assert.equal(result.sessionId, 'sess-abc');
  child.emit('close', 0);
  await proc.close();
});

test('B: successful PI auto-retry does not mark the settled turn rate-limited', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k2', sessionId: null, resume: false });
  const child = s.children[0];
  await bootstrap(child);
  const turnPromise = proc.send({ text: 'do stuff' });
  const transientError = 'Codex error: An error occurred while processing your request. You can retry your request.';
  pushLine(child, { type: 'agent_end', messages: [{
    role: 'assistant', stopReason: 'error', errorMessage: transientError,
  }] });
  pushLine(child, { type: 'auto_retry_start', attempt: 1, errorMessage: transientError });
  pushLine(child, { type: 'auto_retry_end', success: true, attempt: 1 });
  pushLine(child, { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] });
  pushLine(child, { type: 'agent_settled' });
  await Promise.resolve();
  const result = await turnPromise;
  assert.equal(result.rateLimited, false);
  child.emit('close', 0);
  await proc.close();
});

test('B2: exhausted PI auto-retry rejects with the final provider error', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k2-failed', sessionId: null, resume: false });
  const child = s.children[0];
  await bootstrap(child);
  const turnPromise = proc.send({ text: 'do stuff' });
  const rejection = assert.rejects(turnPromise, /You can retry your request/);
  const finalError = 'Codex error: An error occurred while processing your request. You can retry your request.';
  pushLine(child, { type: 'agent_end', messages: [{
    role: 'assistant', stopReason: 'error', errorMessage: finalError,
  }] });
  pushLine(child, { type: 'auto_retry_end', success: false, attempt: 3, finalError });
  pushLine(child, { type: 'agent_settled' });
  await rejection;
  child.emit('close', 0);
  await proc.close();
});

test('C: sendExtensionUiResponse', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k3', sessionId: null, resume: false }) as PIAgentProcess;
  const child = s.children[0];
  await bootstrap(child);
  proc.sendExtensionUiResponse('ui-req-1', { confirmed: true });
  const written = child.stdin.writeHistory.find((w: string) => w.includes('extension_ui_response'));
  assert.ok(written);
  child.emit('close', 0);
  await proc.close();
});

test('D: sendExtensionUiResponse with value', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k4', sessionId: null, resume: false }) as PIAgentProcess;
  const child = s.children[0];
  await bootstrap(child);
  proc.sendExtensionUiResponse('ui-req-2', { value: 'Option A' });
  const written = child.stdin.writeHistory.find((w: string) => w.includes('extension_ui_response'));
  assert.ok(written);
  child.emit('close', 0);
  await proc.close();
});

// Test E: plan->approval->resume (complex flow)
test('E: plan flow', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k5', sessionId: null, resume: false }) as PIAgentProcess;
  const child = s.children[0];
  await bootstrap(child);
  const turnPromise = proc.send({ text: 'build a feature' });

  const PLAN_PATH = '/repo/plan/my-plan.md';
  pushLine(child, { type: 'tool_execution_start', toolCallId: 'tc-write', toolName: 'write', args: { file_path: PLAN_PATH, content: 'Plan: do X' } });
  pushLine(child, { type: 'tool_execution_end', toolCallId: 'tc-write', result: { content: [{ type: 'text', text: 'Written.' }] } });
  await Promise.resolve();

  pushLine(child, { type: 'tool_execution_start', toolCallId: 'tc-epm', toolName: 'exit_plan_mode', args: { plan: 'Plan: do X' } });
  await Promise.resolve();

  const collectedEvents: string[] = [];
  const collectLoop = (async () => { for await (const evt of proc.events) { collectedEvents.push(evt.type); if (evt.type === 'turn_complete') break; } })();

  pushLine(child, { type: 'extension_ui_request', id: 'ui-confirm-1', method: 'confirm', title: 'Plan ready for review — approve to proceed with implementation.' });
  await Promise.resolve();
  proc.sendExtensionUiResponse('ui-confirm-1', { confirmed: true });
  pushLine(child, { type: 'tool_execution_end', toolCallId: 'tc-epm', result: { content: [{ type: 'text', text: 'Plan approved.' }] } });
  pushLine(child, { type: 'agent_end', messages: [{ role: 'assistant', content: 'done', usage: { cost: { total: 0.01 } } }] });
  pushLine(child, { type: 'agent_settled' });
  await Promise.resolve();
  await Promise.resolve();

  const result = await turnPromise;
  await collectLoop;
  assert.equal(result.planFilePath, PLAN_PATH);
  assert.equal(result.exitedPlanMode, true);
  child.emit('close', 0);
  await proc.close();
});

// Test F: ask_user_question via extension_ui
test('F: ask_user_question', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k6', sessionId: null, resume: false }) as PIAgentProcess;
  const child = s.children[0];
  await bootstrap(child);
  const turnPromise = proc.send({ text: 'ask me something' });
  pushLine(child, { type: 'tool_execution_start', toolCallId: 'tc-aq', toolName: 'ask_user_question', args: { questions: [{ question: 'What color?' }] } });
  await Promise.resolve();
  pushLine(child, { type: 'extension_ui_request', id: 'ui-sel-1', method: 'select', title: 'What color?', options: ['Red', 'Blue'] });
  await Promise.resolve();
  proc.sendExtensionUiResponse('ui-sel-1', { value: 'Blue' });
  pushLine(child, { type: 'tool_execution_end', toolCallId: 'tc-aq', result: { content: [{ type: 'text', text: 'Blue' }] } });
  pushLine(child, { type: 'agent_end', messages: [] });
  pushLine(child, { type: 'agent_settled' });
  await Promise.resolve();
  const result = await turnPromise;
  assert.equal(result.askUserQuestions, undefined);
  child.emit('close', 0);
  await proc.close();
});

// Test G: fatal error
test('G: fatal error', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k7', sessionId: null, resume: false });
  const child = s.children[0];
  await bootstrap(child);
  const turnPromise = proc.send({ text: 'do something' });
  child.stderr.write('fatal: something broke\n');
  child.emit('close', 1);
  await Promise.resolve();
  await assert.rejects(turnPromise, /fatal|something broke|exited/i);
  await proc.close().catch(() => {});
});

// Test H: clean exit without turn_complete
test('H: clean exit before turn_complete', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k8', sessionId: null, resume: false });
  const child = s.children[0];
  await bootstrap(child);
  const turnPromise = proc.send({ text: 'do work' });
  child.emit('close', 0);
  await Promise.resolve();
  await assert.rejects(turnPromise, /exited before turn_complete/i);
  await proc.close().catch(() => {});
});

// ─── Tool allowlist gating (thread agents must not get interaction tools) ───

function makeMockPi() {
  const registered: string[] = [];
  const pi: any = {
    on: () => {},
    registerTool: (def: any) => { registered.push(def.name); },
  };
  return { pi, registered };
}

function makeCapturingSpawner() {
  const calls: any[] = [];
  const children: any[] = [];
  return {
    calls,
    children,
    spawn: (bin: string, args: string[], opts: any) => {
      calls.push({ bin, args, opts });
      const c = makeStubChild();
      children.push(c);
      return c;
    },
  };
}

const CODER_TOOLS = 'Agent,Bash,Edit,Glob,Grep,Read,Skill,TaskStop,TodoWrite,WebFetch,WebSearch,Write';

test('I: makeToolGate — unset/empty env allows all pseudo-tools', () => {
  for (const env of [undefined, '', '   ']) {
    const gate = makeToolGate(env);
    for (const label of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'TodoWrite']) {
      assert.equal(gate(label), true, `${label} should be allowed when env=${JSON.stringify(env)}`);
    }
  }
});

test('I2: makeToolGate — coder allowlist excludes the three interaction tools', () => {
  const gate = makeToolGate(CODER_TOOLS);
  assert.equal(gate('TodoWrite'), true);
  assert.equal(gate('AskUserQuestion'), false);
  assert.equal(gate('EnterPlanMode'), false);
  assert.equal(gate('ExitPlanMode'), false);
});

test('I3: makeToolGate — trims surrounding whitespace in entries', () => {
  const gate = makeToolGate(' Bash , TodoWrite ');
  assert.equal(gate('Bash'), true);
  assert.equal(gate('TodoWrite'), true);
  assert.equal(gate('ExitPlanMode'), false);
});

test('J: toolShims registers only allowed pseudo-tools under a coder allowlist', () => {
  const prev = process.env.CORTEX_PI_ALLOWED_TOOLS;
  process.env.CORTEX_PI_ALLOWED_TOOLS = CODER_TOOLS;
  try {
    const { pi, registered } = makeMockPi();
    toolShims(pi);
    assert.ok(!registered.includes('ask_user_question'), 'ask_user_question must NOT be registered');
    assert.ok(!registered.includes('enter_plan_mode'), 'enter_plan_mode must NOT be registered');
    assert.ok(!registered.includes('exit_plan_mode'), 'exit_plan_mode must NOT be registered');
    assert.ok(registered.includes('todo_write'), 'todo_write must remain registered');
  } finally {
    if (prev === undefined) delete process.env.CORTEX_PI_ALLOWED_TOOLS;
    else process.env.CORTEX_PI_ALLOWED_TOOLS = prev;
  }
});

test('J2: toolShims registers all four pseudo-tools when env is unset', () => {
  const prev = process.env.CORTEX_PI_ALLOWED_TOOLS;
  delete process.env.CORTEX_PI_ALLOWED_TOOLS;
  try {
    const { pi, registered } = makeMockPi();
    toolShims(pi);
    for (const n of ['ask_user_question', 'enter_plan_mode', 'exit_plan_mode', 'todo_write']) {
      assert.ok(registered.includes(n), `${n} should be registered when no allowlist is set`);
    }
  } finally {
    if (prev === undefined) delete process.env.CORTEX_PI_ALLOWED_TOOLS;
    else process.env.CORTEX_PI_ALLOWED_TOOLS = prev;
  }
});

test('K: spawn forwards rawTools allowlist to the subprocess env', async () => {
  const s = makeCapturingSpawner();
  const adapter = new PIAdapter(s.spawn as any, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'kEnv', sessionId: null, resume: false, rawTools: CODER_TOOLS });
  const child = s.children[0];
  await bootstrap(child);
  assert.equal(s.calls[0].opts.env.CORTEX_PI_ALLOWED_TOOLS, CODER_TOOLS);
  child.emit('close', 0);
  await proc.close();
});

test('K2: spawn omits CORTEX_PI_ALLOWED_TOOLS when rawTools is unset', async () => {
  const prev = process.env.CORTEX_PI_ALLOWED_TOOLS;
  delete process.env.CORTEX_PI_ALLOWED_TOOLS;
  try {
    const s = makeCapturingSpawner();
    const adapter = new PIAdapter(s.spawn as any, SESSION_DIR);
    const proc = adapter.spawn({ sessionKey: 'kEnv2', sessionId: null, resume: false });
    const child = s.children[0];
    await bootstrap(child);
    assert.equal(s.calls[0].opts.env.CORTEX_PI_ALLOWED_TOOLS, undefined);
    child.emit('close', 0);
    await proc.close();
  } finally {
    if (prev !== undefined) process.env.CORTEX_PI_ALLOWED_TOOLS = prev;
  }
});

console.error("All tests registered");
