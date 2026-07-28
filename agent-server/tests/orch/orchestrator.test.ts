// input:  Orchestrator class
// output: unit tests — two-branch decision tree routing [S8-A]
// pos:    verifies (a) threadAddMatch, (b) isActiveThread, (c) threadStartMatch → thread executor;
//         (d) no match → agent runner; (e) both flags set → thread executor wins
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Orchestrator } from '../../src/orchestration/orchestrator.js';
import type { OrchMessageContext } from '../../src/orchestration/orchestrator.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<OrchMessageContext> = {}): OrchMessageContext {
  return {
    message: { ref: { channel: 'C1', messageId: 'M1', threadId: null }, text: 'hello', isBot: false, files: [], subtype: undefined } as any,
    channel: 'C1',
    adapter: {} as any,
    threadAnchorId: null,
    hasFiles: false,
    userMessage: 'hello',
    agentMessage: 'hello',
    threadAddMatch: null,
    threadStartMatch: null,
    existingThread: null,
    isActiveThread: false,
    ...overrides,
  };
}

function makeRunner() {
  const calls: any[][] = [];
  return {
    calls,
    runner: { async route(ctx: any) { calls.push([ctx]); } },
  };
}

// ── (a) threadAddMatch → threadExecutor.route ─────────────────────────────────

test('(a) threadAddMatch set → threadExecutor.route called, not agentRunner.route', async () => {
  const agentSpy = makeRunner();
  const threadSpy = makeRunner();
  const orch = new Orchestrator({ agentRunner: agentSpy.runner, threadExecutor: threadSpy.runner });

  const ctx = makeCtx({ threadAddMatch: ['!thread add main', 'main'] as any });
  await orch.handleMessage(ctx);

  assert.equal(threadSpy.calls.length, 1, 'threadExecutor.route called once');
  assert.equal(agentSpy.calls.length, 0, 'agentRunner.route NOT called');
  assert.equal(threadSpy.calls[0][0], ctx, 'ctx passed through unchanged');
});

// ── (b) isActiveThread=true → threadExecutor.route ───────────────────────────

test('(b) isActiveThread=true → threadExecutor.route called', async () => {
  const agentSpy = makeRunner();
  const threadSpy = makeRunner();
  const orch = new Orchestrator({ agentRunner: agentSpy.runner, threadExecutor: threadSpy.runner });

  const ctx = makeCtx({ isActiveThread: true, existingThread: { id: 'thr-1', status: 'running' } });
  await orch.handleMessage(ctx);

  assert.equal(threadSpy.calls.length, 1);
  assert.equal(agentSpy.calls.length, 0);
});

// ── (c) threadStartMatch → threadExecutor.route ──────────────────────────────

test('(c) threadStartMatch set → threadExecutor.route called', async () => {
  const agentSpy = makeRunner();
  const threadSpy = makeRunner();
  const orch = new Orchestrator({ agentRunner: agentSpy.runner, threadExecutor: threadSpy.runner });

  const ctx = makeCtx({ threadStartMatch: ['!thread coder hello', 'coder', 'hello'] as any });
  await orch.handleMessage(ctx);

  assert.equal(threadSpy.calls.length, 1);
  assert.equal(agentSpy.calls.length, 0);
});

// ── (d) no match → agentRunner.route ─────────────────────────────────────────

test('(d) no thread context → agentRunner.route called, not threadExecutor.route', async () => {
  const agentSpy = makeRunner();
  const threadSpy = makeRunner();
  const orch = new Orchestrator({ agentRunner: agentSpy.runner, threadExecutor: threadSpy.runner });

  const ctx = makeCtx();
  await orch.handleMessage(ctx);

  assert.equal(agentSpy.calls.length, 1, 'agentRunner.route called once');
  assert.equal(threadSpy.calls.length, 0, 'threadExecutor.route NOT called');
  assert.equal(agentSpy.calls[0][0], ctx);
});

// ── (e) threadAddMatch + threadStartMatch both set → threadExecutor wins ──────

test('(e) threadAddMatch takes precedence over threadStartMatch for thread routing', async () => {
  const agentSpy = makeRunner();
  const threadSpy = makeRunner();
  const orch = new Orchestrator({ agentRunner: agentSpy.runner, threadExecutor: threadSpy.runner });

  const ctx = makeCtx({
    threadAddMatch: ['!thread add main', 'main'] as any,
    threadStartMatch: ['!thread coder hi', 'coder', 'hi'] as any,
  });
  await orch.handleMessage(ctx);

  assert.equal(threadSpy.calls.length, 1);
  assert.equal(agentSpy.calls.length, 0);
});
