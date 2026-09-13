// input:  Node test runner + runHookInjection / onNewInjectSessionKey
// output: regression tests for the cc-backend `!new` + onNew memory-hook session race.
// pos:    The onNew (pre-close) hook injects its stdout as a final agent turn on the OLD
//         session. It must run on an ISOLATED pool key — NOT the channel — and close that
//         key after the turn; otherwise the resurrected old session collides with the live
//         channel pool slot and the next conversation !new starts resumes the old session.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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
    ctx: { channel, sessionId: oldSessionId, sessionName: oldSessionId.slice(0, 8), profile: null },
    format: { statusLine: () => '', previewLine: () => '', errorLine: () => '' },
    inject: {
      targetSessionId: oldSessionId,
      profileName: null,
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
  assert.equal(request.session.backendSessionId, 'old-sess', 'injection resumes the OLD session (pre-close turn)');
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
    ctx: { channel, sessionId: 'live-sess', sessionName: 'live', profile: null },
    format: { statusLine: () => '', previewLine: () => '', errorLine: () => '' },
    inject: { targetSessionId: 'live-sess', profileName: null, sessionKey: channel, trigger: 'hook:onMessageEnd' },
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
