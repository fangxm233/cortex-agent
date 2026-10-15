import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { OutputStream } from '../src/platform/output-stream.js';
import type { AgentRun } from '../src/domain/runs/run.js';
import type { RunObserver, RunRequest } from '../src/domain/runs/request.js';
import {
  onNewInjectSessionKey,
  runHookInjection,
  type SessionHookSpec,
  type InjectDeps,
} from '../src/domain/sessions/session-hooks.js';

const selection = { backend: 'claude' as const, provider: null, model: 'opus', thinking: 'high', mode: 'plan' };

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Minimal OutputStream stub — records emitted text, no platform coupling. */
function makeStream(): OutputStream & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    emitText(t: string) { texts.push(t); },
    openMutable() { return { update: () => {} }; },
    async postInteractive() { return null; },
    async flush() {},
    getRefs() { return []; },
    getParentRef() { return null; },
  };
}

function resolvedRun(sessionId: string): AgentRun {
  return {
    executionId: 'exec-hook',
    result: Promise.resolve({ sessionId, total_cost_usd: null, num_turns: null } as never),
  } as unknown as AgentRun;
}

function makeDeps() {
  const startRunCalls: Array<{ request: RunRequest; observers: RunObserver[] }> = [];
  const closeCalls: Array<{ channel: string; sessionKey: string }> = [];
  const deps: InjectDeps = {
    startRun: (request: RunRequest, observers: RunObserver[]): AgentRun => {
      startRunCalls.push({ request, observers });
      return resolvedRun('new-from-run');
    },
    closeInjectedSession: async (channel: string, sessionKey: string) => {
      closeCalls.push({ channel, sessionKey });
    },
  };
  return { deps, startRunCalls, closeCalls };
}

function onNewSpec(channel: string, oldSessionId: string): SessionHookSpec {
  return {
    name: 'onNew',
    ctx: { channel, sessionId: oldSessionId, selection },
    format: { statusLine: () => '', previewLine: () => '', errorLine: () => '' },
    inject: {
      sessionId: `track-${oldSessionId}`,
      backendSessionId: oldSessionId,
      selection,
      sessionKey: onNewInjectSessionKey(channel),
      trigger: 'hook:onNew',
    },
  };
}

// ── (1) Isolation invariant — the core of the fix ───────────────────────────────

test('onNewInjectSessionKey — returns a pool key distinct from the channel (deterministic)', () => {
  assert.notEqual(onNewInjectSessionKey('C-chan'), 'C-chan',
    'the onNew injection key must NOT equal the channel live pool slot — that is the race');
  assert.equal(onNewInjectSessionKey('C-chan'), onNewInjectSessionKey('C-chan'),
    'must be deterministic for the same channel');
  assert.notEqual(onNewInjectSessionKey('C-a'), onNewInjectSessionKey('C-b'),
    'distinct channels get distinct injection keys');
});

// ── (2) onNew injects on the isolated key + resumes old session + closes after ──

test('runHookInjection (onNew) — injects on the isolated key, resumes the OLD session, closes it after', async () => {
  const channel = 'C-chan';
  const { deps, startRunCalls, closeCalls } = makeDeps();
  const stream = makeStream();

  await runHookInjection('write memory', onNewSpec(channel, 'old-sess'), stream, deps);

  assert.equal(startRunCalls.length, 1, 'startRun called exactly once');
  const request = startRunCalls[0].request;
  assert.deepEqual(request.selection, selection, 'full selection retained without channel re-resolution');
  assert.equal(request.session.backendSessionId, 'old-sess', 'injection resumes the OLD session (pre-close turn)');
  assert.equal(request.session.sessionId, 'track-old-sess', 'as a turn of its Cortex session');
  assert.equal(request.session.engineKey, onNewInjectSessionKey(channel), 'injection uses the isolated pool key');
  assert.notEqual(request.session.engineKey, channel,
    'injection must NOT reuse the channel live pool slot — otherwise the new conversation resumes the old session');

  assert.equal(closeCalls.length, 1, 'isolated injected session is closed after the turn (no leaked process)');
  assert.deepEqual(closeCalls[0], { channel, sessionKey: onNewInjectSessionKey(channel) });
});

// ── (3) onMessageEnd uses the channel key and does NOT close the live session ──

test('runHookInjection (onMessageEnd) — injects on the channel key and does NOT close the live session', async () => {
  const channel = 'C-chan';
  const { deps, startRunCalls, closeCalls } = makeDeps();
  const stream = makeStream();
  const spec: SessionHookSpec = {
    name: 'onMessageEnd',
    ctx: { channel, sessionId: 'live-sess', selection },
    format: { statusLine: () => '', previewLine: () => '', errorLine: () => '' },
    inject: {
      sessionId: 'track-live', backendSessionId: 'live-sess', selection, sessionKey: channel,
      trigger: 'hook:onMessageEnd',
    },
  };

  await runHookInjection('reminder', spec, stream, deps);

  assert.equal(startRunCalls[0].request.session.engineKey, channel,
    'onMessageEnd continues the channel live session (same pool slot)');
  assert.equal(closeCalls.length, 0,
    'onMessageEnd must NOT close the channel live session — it is the user conversation');
});

// ── (4) Robustness — isolated session is closed even when the injected turn fails ──

test('runHookInjection (onNew) — closes the isolated session even when the injected turn throws', async () => {
  const channel = 'C-chan';
  const closeCalls: Array<{ channel: string; sessionKey: string }> = [];
  const deps: InjectDeps = {
    startRun: (): AgentRun => ({
      executionId: 'exec-hook', result: Promise.reject(new Error('boom')),
    } as unknown as AgentRun),
    closeInjectedSession: async (ch: string, key: string) => { closeCalls.push({ channel: ch, sessionKey: key }); },
  };
  const stream = makeStream();

  await runHookInjection('write memory', onNewSpec(channel, 'old-sess'), stream, deps);

  assert.equal(closeCalls.length, 1, 'isolated session must be closed in finally even on failure');
  assert.deepEqual(closeCalls[0], { channel, sessionKey: onNewInjectSessionKey(channel) });
});

// ── (5) onMessageEnd lands on the live engine of the turn it follows ────────────

test('runHookInjection (onMessageEnd) — reuses the finished turn\'s request so the pool keeps its engine', async () => {
  const channel = 'web:live';
  const { deps, startRunCalls } = makeDeps();
  const turn = {
    runId: 'run-turn',
    session: { sessionId: 'track-live', backendSessionId: null, engineKey: channel},
    selection,
    spec: { tools: 'Bash,Read', pluginDirs: ['/plugins/coder'] },
    prompt: { text: 'hello', attachments: [] },
    context: { channel, project: 'proj', trigger: 'user', isUserInitiated: true, teamLead: true },
    policy: { background: 'hold', mcpComposition: 'direct', browserCdpEndpoint: 'http://127.0.0.1:9222' },
  } as unknown as RunRequest;
  const spec: SessionHookSpec = {
    name: 'onMessageEnd',
    ctx: { channel, sessionId: 'track-live', backendSessionId: 'backend-live', selection },
    format: { statusLine: () => '', previewLine: () => '', errorLine: () => '' },
    inject: {
      sessionId: 'track-live', backendSessionId: 'backend-live', selection, sessionKey: channel,
      trigger: 'hook:onMessageEnd', follows: turn,
    },
  };

  await runHookInjection('reminder', spec, makeStream(), deps);

  const injected = startRunCalls[0].request;
  assert.notEqual(injected.runId, turn.runId);
  assert.deepEqual(injected.session, { ...turn.session, backendSessionId: 'backend-live' });
  assert.deepEqual(injected.prompt, { text: 'reminder', attachments: [] });
  // Recorded as the hook's turn, routed like the turn it follows (the route is the engine's).
  assert.deepEqual(injected.context, { ...turn.context, trigger: 'hook:onMessageEnd', routeTrigger: 'user' });
  assert.equal(injected.spec, turn.spec);
  assert.equal(injected.policy, turn.policy);
  assert.equal(injected.selection, turn.selection);
});
