// input:  a fake PI extension host and compiled benchmark policy guards
// output: guarded shim registration and fail-closed tool_call dispatch
// pos:    Regression suite for design §13 GT6 at PI's dispatch boundary
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { it } from 'vitest';
import type {
  ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallReturn, ToolDefinition,
} from '../../src/agent-adapter/pi/pi-ext-types.js';
import {
  GATE2_LEASE_STATE,
  PI_LEASE_STATE_ENV,
  PI_POLICY_GUARD_ENV,
  benchmarkToolGate,
  compilePiPolicyGuard,
} from '../../src/agent-adapter/pi/policy-guard.js';
import { installToolShims } from '../../src/agent-adapter/pi/tool-shims.js';

type ToolCallHandler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallReturn> | ToolCallReturn;

interface FakePi {
  api: ExtensionAPI;
  registered: string[];
  toolCallHandlers: ToolCallHandler[];
  sessionStart: Array<(event: unknown, ctx: ExtensionContext) => unknown>;
}

function fakePi(): FakePi {
  const registered: string[] = [];
  const toolCallHandlers: ToolCallHandler[] = [];
  const sessionStart: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
  const api = {
    on(event: string, handler: (...args: never[]) => unknown): void {
      if (event === 'tool_call') toolCallHandlers.push(handler as unknown as ToolCallHandler);
      if (event === 'session_start') {
        sessionStart.push(handler as unknown as (event: unknown, ctx: ExtensionContext) => unknown);
      }
    },
    registerTool(def: ToolDefinition): void {
      registered.push(def.name);
    },
  } as unknown as ExtensionAPI;
  return { api, registered, toolCallHandlers, sessionStart };
}

const ANSWER_ONLY = { [GATE2_LEASE_STATE]: ['read', 'grep', 'glob', 'thread_run'] };
const CODING = { [GATE2_LEASE_STATE]: ['read', 'grep', 'glob', 'bash', 'write', 'edit', 'web_fetch'] };

function guardEnv(guard: unknown): NodeJS.ProcessEnv {
  return {
    [PI_POLICY_GUARD_ENV]: JSON.stringify(guard),
    [PI_LEASE_STATE_ENV]: GATE2_LEASE_STATE,
  };
}

async function dispatch(pi: FakePi, toolName: string): Promise<ToolCallReturn> {
  assert.equal(pi.toolCallHandlers.length, 1, 'exactly one guard handler must be installed');
  return pi.toolCallHandlers[0](
    { toolName, toolCallId: 'call-1', input: {} },
    {} as ExtensionContext,
  );
}

// --- registration is gated on PI-native names, not Claude labels (§6.6) ---

it('registers only the shims the guard allow-lists, by PI-native name', () => {
  const pi = fakePi();
  installToolShims(pi.api, guardEnv(CODING));
  assert.deepEqual(pi.registered, ['web_fetch']);
});

it('registers no shim at all when the guard allow-lists none of them', () => {
  const pi = fakePi();
  installToolShims(pi.api, guardEnv(ANSWER_ONLY));
  assert.deepEqual(pi.registered, []);
  assert.deepEqual(pi.sessionStart, []);
});

// --- §6.6 defect 3: PI's own built-ins are now consulted ---

it('blocks a denied PI built-in at the dispatch boundary', async () => {
  const pi = fakePi();
  installToolShims(pi.api, guardEnv(ANSWER_ONLY));
  for (const builtin of ['bash', 'write', 'edit']) {
    const outcome = await dispatch(pi, builtin);
    assert.deepEqual((outcome as { block: true }).block, true, `${builtin} must be blocked`);
  }
});

it('lets an allow-listed tool through the dispatch boundary', async () => {
  const pi = fakePi();
  installToolShims(pi.api, guardEnv(ANSWER_ONLY));
  assert.equal(await dispatch(pi, 'read'), undefined);
  assert.equal(await dispatch(pi, 'thread_run'), undefined);
});

// --- T8: an evaluator that throws denies, and does not fall back to allow-all ---

it('blocks the tool call when the guard evaluator throws (T8)', async () => {
  const pi = fakePi();
  installToolShims(
    pi.api,
    { CORTEX_PI_ALLOWED_TOOLS: '' },
    benchmarkToolGate(() => { throw new Error('evaluator exploded'); }, GATE2_LEASE_STATE),
  );
  for (const tool of ['read', 'bash', 'thread_run']) {
    const outcome = await dispatch(pi, tool);
    assert.equal((outcome as { block: true }).block, true, `${tool} must be blocked`);
  }
  assert.deepEqual(pi.registered, []);
});

it('blocks the tool call when the guard is present but unreadable (T7)', async () => {
  const pi = fakePi();
  installToolShims(pi.api, { [PI_POLICY_GUARD_ENV]: '{', CORTEX_PI_ALLOWED_TOOLS: '' });
  const outcome = await dispatch(pi, 'read');
  assert.equal((outcome as { block: true }).block, true);
});

// --- the unguarded daemon path is unchanged ---

it('keeps the shipped allowlist behaviour when no guard is installed', () => {
  const permissive = fakePi();
  installToolShims(permissive.api, { CORTEX_PI_SUBAGENT: '0' });
  assert.deepEqual(permissive.registered, [
    'web_fetch', 'web_search', 'ask_user_question', 'enter_plan_mode', 'exit_plan_mode', 'todo_write',
  ]);
  assert.equal(permissive.sessionStart.length, 1, 'the runtime Agent tool stays registered');
  assert.deepEqual(permissive.toolCallHandlers, [], 'no dispatch guard outside benchmark mode');

  const restricted = fakePi();
  installToolShims(restricted.api, { CORTEX_PI_ALLOWED_TOOLS: 'WebFetch,TodoWrite' });
  assert.deepEqual(restricted.registered, ['web_fetch', 'todo_write']);
  assert.equal(restricted.sessionStart.length, 0);
});

it('compiles the same guard the adapter serializes into the environment', () => {
  const evaluate = compilePiPolicyGuard(JSON.parse(guardEnv(ANSWER_ONLY)[PI_POLICY_GUARD_ENV] as string));
  assert.equal(evaluate('read', GATE2_LEASE_STATE).allow, true);
  assert.equal(evaluate('bash', GATE2_LEASE_STATE).allow, false);
});
