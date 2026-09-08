// input:  PI Agent tool, parent env, fake nested child sessions
// output: Schema, chain prompt, isolation, attribution and usage regressions
// pos:    Tests PI subagent contracts
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import {
  createSubagentTool,
  MAX_SUBAGENT_TASKS,
  type SubagentModelOption,
  type SubagentToolDeps,
} from '../src/agent-adapter/pi/subagent.js';
import type { ChildSessionHandle, ChildSessionRequest } from '../src/agent-adapter/pi/child-session.js';
import { PI_INTERACTION_BRIDGE_ENV } from '../src/agent-adapter/pi/session-options.js';
import {
  createPIEventParserState,
  piEventToNormalized,
  type SubagentNotice,
} from '../src/agent-adapter/pi/event-parser.js';

/**
 * A nested PI session, faked. `prompt()` stays pending until the test settles it, exactly as the
 * SDK's does while its run is live, so a test controls when a child finishes relative to its
 * siblings. `abort()` settles the pending run the way the SDK does: the promise comes back, and it
 * is the caller's own abort signal — not the session — that says the run was cancelled.
 */
class FakeChildSession {
  readonly prompts: string[] = [];
  abortCalls = 0;
  disposeCalls = 0;
  private readonly listeners = new Set<(event: any) => void>();
  private settle: { resolve: () => void; reject: (error: unknown) => void } | undefined;

  subscribe(listener: (event: any) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  prompt(text: string): Promise<void> {
    this.prompts.push(text);
    return new Promise<void>((resolve, reject) => { this.settle = { resolve, reject }; });
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    this.settle?.resolve();
  }

  /** Deliver one session event to every live subscriber. */
  emit(event: Record<string, unknown>): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** The ordinary ending: one assistant message, then the run resolves. */
  finish(
    text = 'done',
    usage: Record<string, unknown> = {},
    terminal: TerminalState = {},
  ): void {
    this.emit(assistantEvent(text, usage, terminal));
    this.settle?.resolve();
  }

  /** The run itself rejects — the SDK's way of reporting a session that could not complete. */
  fail(error: Error): void {
    this.settle?.reject(error);
  }
}

interface TerminalState {
  stopReason?: string;
  errorMessage?: string;
  model?: string;
}

interface Harness {
  root: string;
  agentDir: string;
  /** Every child session request, including the ones the factory refused. */
  calls: ChildSessionRequest[];
  /** The env each child's extensions were built over, aligned with `calls`. */
  childEnvs: NodeJS.ProcessEnv[];
  /** Only the children that got a session. */
  sessions: FakeChildSession[];
  notices: SubagentNotice[];
  /** Call indexes the factory rejects instead of serving. */
  failAt: Set<number>;
  tool: any;
  cleanup: () => void;
}

function writeRole(
  agentDir: string,
  name: string,
  options: { model?: string; tools?: string } = {},
): void {
  const roleDir = path.join(agentDir, 'agents');
  fs.mkdirSync(roleDir, { recursive: true });
  const model = options.model ? `model: ${options.model}\n` : '';
  const tools = options.tools ? `tools: ${options.tools}\n` : '';
  fs.writeFileSync(path.join(roleDir, `${name}.md`), [
    '---',
    `name: ${name}`,
    `description: ${name} role`,
    model + tools + '---',
    '',
    `You are the ${name} role.`,
  ].join('\n'));
}

/** The parent's env, carrying exactly the entries a child must lose plus one it must keep. */
function parentEnv(agentDir: string): NodeJS.ProcessEnv {
  return {
    CORTEX_THREAD_ID: 'thr_parent',
    CORTEX_TASK_ID: 'task_parent',
    [PI_INTERACTION_BRIDGE_ENV]: '1',
    PI_CODING_AGENT_DIR: path.join(agentDir, 'not-the-child-dir'),
    CORTEX_PI_PARENT_MARKER: 'inherited',
  };
}

function createHarness(
  role: { model?: string; tools?: string } = {},
  options: { attributed?: boolean } = {},
): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-subagent-'));
  const agentDir = path.join(root, 'pi');
  writeRole(agentDir, 'explore', role);

  const calls: ChildSessionRequest[] = [];
  const childEnvs: NodeJS.ProcessEnv[] = [];
  const sessions: FakeChildSession[] = [];
  const notices: SubagentNotice[] = [];
  const failAt = new Set<number>();

  const deps: SubagentToolDeps = {
    agentDir,
    ensureRoles: () => undefined,
    createSession: async (request): Promise<ChildSessionHandle> => {
      const index = calls.length;
      calls.push(request);
      if (failAt.has(index)) throw new Error(`child session ${index} could not start`);
      const session = new FakeChildSession();
      sessions.push(session);
      return {
        session: session as unknown as ChildSessionHandle['session'],
        dispose: () => { session.disposeCalls += 1; },
      };
    },
    childExtensions: (env) => {
      childEnvs.push(env);
      return [];
    },
    parentEnv: parentEnv(agentDir),
    ...(options.attributed === false ? {} : { onEvent: (notice) => { notices.push(notice); } }),
  };

  return {
    root,
    agentDir,
    calls,
    childEnvs,
    sessions,
    notices,
    failAt,
    tool: createSubagentTool(deps) as any,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function context(root: string, model?: { id: string; provider: string }): any {
  return {
    cwd: root,
    model: model ? {
      id: model.id,
      provider: model.provider,
      api: 'anthropic-messages',
      baseUrl: 'https://example.test',
      maxTokens: 8_192,
    } : undefined,
    ui: {},
  };
}

function singleParams(overrides: Record<string, unknown> = {}) {
  return {
    description: 'Inspect code',
    prompt: 'Find the adapter entry point.',
    subagent_type: 'explore',
    ...overrides,
  };
}

function assistantEvent(
  text: string,
  usage: Record<string, unknown> = {},
  terminal: TerminalState = {},
) {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage,
      stopReason: terminal.stopReason ?? 'stop',
      ...(terminal.model ? { model: terminal.model } : {}),
      ...(terminal.errorMessage ? { errorMessage: terminal.errorMessage } : {}),
    },
  };
}

/** Wait until exactly `count` children hold a live session and every one of them has been prompted:
 *  a session that exists but has not been asked anything yet cannot be finished deterministically. */
async function waitForPrompts(harness: Harness, count: number): Promise<void> {
  await vi.waitFor(() => {
    assert.equal(harness.sessions.length, count);
    for (const session of harness.sessions) assert.equal(session.prompts.length, 1);
  });
}

/** The notices the parent collected, put through the parent session's own event stream. This is the
 *  real seam: the Agent tool hands the runtime a notice, the runtime replays it as one raw record. */
function throughParentStream(notices: SubagentNotice[]) {
  const state = createPIEventParserState();
  return notices.flatMap((notice) => piEventToNormalized(
    { type: 'cortex_subagent_event', notice },
    state,
  ));
}

/** Model choices only shape the tool description, so these tools never need a working factory. */
function describedTool(options: SubagentModelOption[]): any {
  const deps: SubagentToolDeps = {
    agentDir: '/nonexistent',
    ensureRoles: () => undefined,
    createSession: async () => { throw new Error('not reached'); },
    childExtensions: () => [],
    parentEnv: {},
  };
  return createSubagentTool(deps, options);
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('Agent schema bounds and deduplicates provider/model choices', () => {
  const tool = describedTool([
    { provider: 'openai-codex', id: 'gpt-5.6-sol' },
    { provider: 'deepseek', id: 'deepseek-v4-flash' },
    { provider: 'openai-codex', id: 'gpt-5.6-sol' },
  ]);
  assert.equal(tool.description.match(/openai-codex\/gpt-5\.6-sol/g)?.length, 1);
  assert.match(tool.description, /deepseek\/deepseek-v4-flash/);

  const manyModels = Array.from({ length: 80 }, (_, index) => ({
    provider: 'provider',
    id: `model-${String(index).padStart(3, '0')}`,
  }));
  const bounded = describedTool(manyModels).description;
  assert.match(bounded, /\+\d+ more/);
  assert.ok(bounded.length <= 1_500);

  const overlong = describedTool([
    { provider: 'a', id: 'x'.repeat(1_300) },
    { provider: 'z', id: 'short-model' },
  ]).description;
  assert.match(overlong, /z\/short-model/);
  assert.doesNotMatch(overlong, /x{100}/);
});

test('single child runs on a nested session with the role scope, a stripped env, and usage', async () => {
  const harness = createHarness({ model: 'role-model', tools: 'read, grep' });
  try {
    const run = harness.tool.execute(
      'tool-1',
      singleParams({ model: 'explicit-model' }),
      undefined,
      undefined,
      context(harness.root, { id: 'parent-model', provider: 'parent-provider' }),
    );
    await waitForPrompts(harness, 1);

    const request = harness.calls[0];
    assert.equal(request.cwd, harness.root);
    assert.equal(request.agentDir, harness.agentDir);
    // An explicit task model wins outright, and it carries no provider of its own.
    assert.equal(request.model, 'explicit-model');
    assert.equal(request.provider, null);
    assert.deepEqual(request.tools, ['read', 'grep']);
    assert.deepEqual(request.appendSystemPrompt, ['You are the explore role.']);
    assert.equal(harness.sessions[0].prompts[0], 'Task: Find the adapter entry point.');

    // The child's env is the parent's, marked as a subagent, re-pointed at the agent dir, and
    // stripped of the parent's thread scope and interaction bridge.
    const childEnv = harness.childEnvs[0];
    assert.equal(childEnv.CORTEX_PI_SUBAGENT, '1');
    assert.equal(childEnv.PI_CODING_AGENT_DIR, harness.agentDir);
    assert.equal(childEnv.CORTEX_PI_PARENT_MARKER, 'inherited');
    assert.equal(childEnv.CORTEX_THREAD_ID, undefined);
    assert.equal(childEnv.CORTEX_TASK_ID, undefined);
    assert.equal(childEnv[PI_INTERACTION_BRIDGE_ENV], undefined);

    harness.sessions[0].finish('child answer', {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 17,
      cost: { total: 0.25 },
    });
    const result = await run;
    assert.equal(result.content[0].text, 'child answer');
    assert.deepEqual(result.details.usage, {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      cost: 0.25,
      contextTokens: 17,
      turns: 1,
    });
    assert.deepEqual(result.details.results[0].usage, result.details.usage);
    assert.equal(harness.sessions[0].disposeCalls, 1);
  } finally {
    harness.cleanup();
  }
});

test('model resolution prefers role frontmatter over inherited parent model', async () => {
  const harness = createHarness({ model: 'role-model' });
  try {
    const run = harness.tool.execute(
      'tool-2', singleParams(), undefined, undefined,
      context(harness.root, { id: 'parent-model', provider: 'parent-provider' }),
    );
    await waitForPrompts(harness, 1);
    assert.equal(harness.calls[0].model, 'role-model');
    assert.equal(harness.calls[0].provider, null);
    harness.sessions[0].finish();
    await run;
  } finally {
    harness.cleanup();
  }
});

test('model resolution inherits parent provider and model when role has no model', async () => {
  const harness = createHarness();
  try {
    const run = harness.tool.execute(
      'tool-3', singleParams(), undefined, undefined,
      context(harness.root, { id: 'parent-model', provider: 'parent-provider' }),
    );
    await waitForPrompts(harness, 1);
    assert.equal(harness.calls[0].provider, 'parent-provider');
    assert.equal(harness.calls[0].model, 'parent-model');
    harness.sessions[0].finish();
    await run;
  } finally {
    harness.cleanup();
  }
});

test('model resolution leaves PI defaults untouched when no source selects a model', async () => {
  const harness = createHarness();
  try {
    const run = harness.tool.execute(
      'tool-4', singleParams(), undefined, undefined, context(harness.root),
    );
    await waitForPrompts(harness, 1);
    assert.equal(harness.calls[0].provider, null);
    assert.equal(harness.calls[0].model, null);
    // No role tools means no allowlist at all: the child keeps PI's own default tool set.
    assert.equal(harness.calls[0].tools, undefined);
    harness.sessions[0].finish();
    await run;
  } finally {
    harness.cleanup();
  }
});

test('later successful retry replaces stale assistant terminal error state', async () => {
  const harness = createHarness();
  try {
    const run = harness.tool.execute(
      'tool-5', singleParams(), undefined, undefined, context(harness.root),
    );
    await waitForPrompts(harness, 1);
    const session = harness.sessions[0];
    session.emit(assistantEvent('failed attempt', {}, {
      stopReason: 'error', errorMessage: 'stale provider error',
    }));
    session.finish('recovered answer');
    const result = await run;
    assert.equal(result.content[0].text, 'recovered answer');
    assert.equal(result.details.results[0].stopReason, 'stop');
    assert.equal(result.details.results[0].errorMessage, undefined);
  } finally {
    harness.cleanup();
  }
});

test('a terminal assistant error becomes a failed Agent result', async () => {
  const harness = createHarness();
  try {
    const run = harness.tool.execute(
      'tool-5b', singleParams(), undefined, undefined, context(harness.root),
    );
    await waitForPrompts(harness, 1);
    harness.sessions[0].finish('partial', {}, {
      stopReason: 'error', errorMessage: 'provider rejected request',
    });
    const result = await run;
    assert.equal(result.details.results[0].stopReason, 'error');
    assert.equal(result.content[0].text, 'Agent failed: provider rejected request');
  } finally {
    harness.cleanup();
  }
});

test('a rejected child run becomes a failed Agent result, not a failed tool call', async () => {
  const harness = createHarness();
  try {
    const run = harness.tool.execute(
      'tool-5c', singleParams(), undefined, undefined, context(harness.root),
    );
    await waitForPrompts(harness, 1);
    harness.sessions[0].fail(new Error('nested session crashed'));
    const result = await run;
    assert.equal(result.details.results[0].stopReason, 'error');
    assert.equal(result.content[0].text, 'Agent failed: nested session crashed');
    // The session is released even though its run never completed.
    assert.equal(harness.sessions[0].disposeCalls, 1);
  } finally {
    harness.cleanup();
  }
});

test('parallel mode starts eight children concurrently and preserves result order', async () => {
  const harness = createHarness();
  try {
    const parallel = Array.from({ length: MAX_SUBAGENT_TASKS }, (_, index) => ({
      description: `Task ${index}`,
      prompt: `Prompt ${index}`,
      subagent_type: 'explore',
    }));
    const run = harness.tool.execute(
      'tool-6', { parallel }, undefined, undefined, context(harness.root),
    );
    await waitForPrompts(harness, MAX_SUBAGENT_TASKS);
    // Finish in reverse: the reported order must follow task position, not completion.
    for (let index = harness.sessions.length - 1; index >= 0; index -= 1) {
      harness.sessions[index].finish(`answer ${index}`, { input: 1, output: 2 });
    }
    const result = await run;
    assert.equal(result.details.mode, 'parallel');
    assert.deepEqual(
      result.details.results.map((entry: any) => entry.output),
      Array.from({ length: MAX_SUBAGENT_TASKS }, (_, index) => `answer ${index}`),
    );
    assert.equal(result.details.usage.input, MAX_SUBAGENT_TASKS);
    assert.equal(result.details.usage.output, MAX_SUBAGENT_TASKS * 2);
    assert.match(result.content[0].text, /Parallel: 8\/8 succeeded/);
    assert.match(result.content[0].text, /### \[Task 0\] completed/);
  } finally {
    harness.cleanup();
  }
});

test('parallel aggregate sums independent child context snapshots', async () => {
  const harness = createHarness();
  try {
    const run = harness.tool.execute('tool-6b', {
      parallel: [
        { description: 'First', prompt: 'One', subagent_type: 'explore' },
        { description: 'Second', prompt: 'Two', subagent_type: 'explore' },
      ],
    }, undefined, undefined, context(harness.root));
    await waitForPrompts(harness, 2);
    harness.sessions[0].finish('one', { totalTokens: 10 });
    harness.sessions[1].finish('two', { totalTokens: 20 });
    const result = await run;
    assert.equal(result.details.results[0].usage.contextTokens, 10);
    assert.equal(result.details.results[1].usage.contextTokens, 20);
    assert.equal(result.details.usage.contextTokens, 30);
  } finally {
    harness.cleanup();
  }
});

test('mode and required-field validation rejects before any session is created', async () => {
  const harness = createHarness();
  const task = singleParams();
  try {
    await assert.rejects(
      harness.tool.execute('tool-6c', {}, undefined, undefined, context(harness.root)),
      /exactly one Agent mode/i,
    );
    await assert.rejects(
      harness.tool.execute(
        'tool-6d', { ...task, parallel: [task] }, undefined, undefined, context(harness.root),
      ),
      /exactly one Agent mode/i,
    );
    for (const key of ['description', 'prompt', 'subagent_type']) {
      await assert.rejects(
        harness.tool.execute(
          `tool-6e-${key}`, singleParams({ [key]: '  ' }),
          undefined, undefined, context(harness.root),
        ),
        new RegExp(`non-empty ${key}`, 'i'),
      );
    }
    assert.equal(harness.calls.length, 0);
  } finally {
    harness.cleanup();
  }
});

test('parallel validates every role before creating any session', async () => {
  const harness = createHarness();
  try {
    await assert.rejects(
      harness.tool.execute('tool-6f', {
        parallel: [
          { description: 'Valid', prompt: 'Run', subagent_type: 'explore' },
          { description: 'Invalid', prompt: 'Do not run', subagent_type: 'missing' },
        ],
      }, undefined, undefined, context(harness.root)),
      /Unknown subagent_type "missing"/,
    );
    assert.equal(harness.calls.length, 0);
  } finally {
    harness.cleanup();
  }
});

test('a child whose session cannot start is a failed result, and its siblings still run', async () => {
  const harness = createHarness();
  harness.failAt.add(0);
  try {
    const run = harness.tool.execute('tool-6g', {
      parallel: [
        { description: 'Broken', prompt: 'Fail', subagent_type: 'explore' },
        { description: 'Healthy', prompt: 'Finish', subagent_type: 'explore' },
      ],
    }, undefined, undefined, context(harness.root));
    await waitForPrompts(harness, 1);
    let settled = false;
    const observed = run.then(
      (result: any) => ({ result }),
      (error: unknown) => ({ error }),
    ).finally(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    const settledBeforeSibling = settled;

    harness.sessions[0].finish('healthy answer');
    const outcome: any = await observed;
    assert.equal(settledBeforeSibling, false);
    assert.equal('error' in outcome, false);
    assert.match(outcome.result.content[0].text, /Parallel: 1\/2 succeeded/);
    assert.equal(outcome.result.details.results[0].stopReason, 'error');
    assert.match(outcome.result.details.results[0].errorMessage, /child session 0 could not start/);
    assert.equal(outcome.result.details.results[1].output, 'healthy answer');
  } finally {
    harness.cleanup();
  }
});

test('parallel and chain reject more than eight tasks', async () => {
  const harness = createHarness();
  const tooMany = Array.from({ length: MAX_SUBAGENT_TASKS + 1 }, (_, index) => ({
    description: `Task ${index}`,
    prompt: `Prompt ${index}`,
    subagent_type: 'explore',
  }));
  try {
    await assert.rejects(
      harness.tool.execute('tool-7a', { parallel: tooMany }, undefined, undefined, context(harness.root)),
      /maximum is 8/i,
    );
    await assert.rejects(
      harness.tool.execute('tool-7b', { chain: tooMany }, undefined, undefined, context(harness.root)),
      /maximum is 8/i,
    );
    assert.equal(harness.calls.length, 0);
  } finally {
    harness.cleanup();
  }
});

test('chain mode is sequential and substitutes previous output', async () => {
  const harness = createHarness();
  try {
    const run = harness.tool.execute('tool-8', {
      chain: [
        { description: 'First', prompt: 'Inspect.', subagent_type: 'explore' },
        { description: 'Second', prompt: 'Summarize {previous}', subagent_type: 'explore' },
      ],
    }, undefined, undefined, context(harness.root));
    await waitForPrompts(harness, 1);
    assert.equal(harness.sessions[0].prompts[0], 'Task: Inspect.');
    harness.sessions[0].finish('first result');
    await waitForPrompts(harness, 2);
    assert.equal(harness.sessions[1].prompts[0], 'Task: Summarize first result');
    harness.sessions[1].finish('second result');
    const result = await run;
    assert.equal(result.content[0].text, 'second result');
    assert.equal(result.details.mode, 'chain');
  } finally {
    harness.cleanup();
  }
});

test('chain stops after a terminal assistant error before starting the next task', async () => {
  const harness = createHarness();
  try {
    const run = harness.tool.execute('tool-8c', {
      chain: [
        { description: 'First', prompt: 'Fail.', subagent_type: 'explore' },
        { description: 'Second', prompt: 'Never run {previous}', subagent_type: 'explore' },
      ],
    }, undefined, undefined, context(harness.root));
    await waitForPrompts(harness, 1);
    harness.sessions[0].finish('failed response', {}, {
      stopReason: 'error', errorMessage: 'provider rejected request',
    });
    const result = await run;
    assert.equal(harness.calls.length, 1);
    assert.equal(result.details.results.length, 1);
    assert.equal(result.content[0].text, 'Agent failed: provider rejected request');
  } finally {
    harness.cleanup();
  }
});

test('abort stops the child session and fails the Agent call', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  try {
    const run = harness.tool.execute(
      'tool-9', singleParams(), controller.signal, undefined, context(harness.root),
    );
    await waitForPrompts(harness, 1);
    controller.abort();
    await assert.rejects(run, /aborted/i);
    assert.equal(harness.sessions[0].abortCalls, 1);
    assert.equal(harness.sessions[0].disposeCalls, 1);
  } finally {
    harness.cleanup();
  }
});

test('parallel abort propagates to every active child', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const parallel = Array.from({ length: MAX_SUBAGENT_TASKS }, (_, index) => ({
    description: `Task ${index}`,
    prompt: `Prompt ${index}`,
    subagent_type: 'explore',
  }));
  try {
    const run = harness.tool.execute(
      'tool-10', { parallel }, controller.signal, undefined, context(harness.root),
    );
    await waitForPrompts(harness, MAX_SUBAGENT_TASKS);
    controller.abort();
    await assert.rejects(run, /aborted/i);
    for (const session of harness.sessions) {
      assert.equal(session.abortCalls, 1);
      assert.equal(session.disposeCalls, 1);
    }
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Attribution: the child's stream, carried out to the parent
// ---------------------------------------------------------------------------

test('a PI subagent\'s tool calls and prose reach the parent stream, attributed to that child', async () => {
  // A subagent runs on its own nested session: nothing it emits reaches the parent's stream on its
  // own, and the parent only ever kept `message_end` for itself. These events exist in the parent's
  // transcript at all only because subagent.ts forwards them as notices.
  const harness = createHarness({ model: 'role-model' });
  try {
    const run = harness.tool.execute(
      'tool-parent', singleParams(), undefined, undefined, context(harness.root),
    );
    await waitForPrompts(harness, 1);
    const session = harness.sessions[0];

    session.emit({
      type: 'tool_execution_start', toolCallId: 'c1', toolName: 'grep', args: { pattern: 'x' },
    });
    session.emit({
      type: 'tool_execution_end', toolCallId: 'c1', isError: false,
      result: { content: [{ type: 'text', text: 'two hits' }] },
    });
    // A message_end that names its model — that is the only place the subagent's model exists.
    session.finish('child answer', {}, { model: 'child-model' });
    await run;

    const events = throughParentStream(harness.notices) as any[];
    assert.deepEqual(events.map((event) => event.type), ['tool_use', 'tool_result', 'assistant_text']);

    // Every row names the child that produced it. The ref carries the child index because one
    // `agent` call may run up to eight.
    for (const event of events) {
      assert.equal(event.subagent.parentToolUseId, 'tool-parent#0');
      assert.equal(event.subagent.type, 'explore');
      assert.equal(event.subagent.description, 'Inspect code');
    }
    // Child tool ids are namespaced: two parallel children number their calls independently.
    assert.equal(events[0].toolUseId, 'tool-parent#0:c1');
    assert.equal(events[0].name, 'grep');
    assert.deepEqual(events[0].input, { pattern: 'x' });
    assert.equal(events[1].content, 'two hits');
    assert.equal(events[2].text, 'child answer');
    // The model is the one that ANSWERED, read off the child's own message.
    assert.equal(events[2].subagent.model, 'child-model');
  } finally {
    harness.cleanup();
  }
});

test('later chain children report substituted runtime prompts once when they start', async () => {
  const harness = createHarness({ model: 'role-model' });
  try {
    const run = harness.tool.execute(
      'tool-parent',
      { chain: [
        { description: 'first', prompt: 'seed', subagent_type: 'explore' },
        { description: 'second', prompt: 'Use {previous} now', subagent_type: 'explore' },
      ] },
      undefined, undefined, context(harness.root),
    );
    await waitForPrompts(harness, 1);
    harness.sessions[0].finish('RESULT');
    await waitForPrompts(harness, 2);
    harness.sessions[1].finish('done');
    await run;

    const events = throughParentStream(harness.notices) as any[];
    const first = events.filter((event) => event.subagent.parentToolUseId === 'tool-parent#0');
    const second = events.filter((event) => event.subagent.parentToolUseId === 'tool-parent#1');
    assert.equal(
      first.some((event) => event.subagent.prompt), false,
      'the first prompt was already announced on the parent call',
    );
    assert.equal(second[0].subagent.prompt, 'Use RESULT now');
    assert.equal(second.filter((event) => event.subagent.prompt).length, 1);
  } finally {
    harness.cleanup();
  }
});

test('parallel children keep separate blocks, keyed by task position not completion order', async () => {
  const harness = createHarness({ model: 'role-model' });
  try {
    const run = harness.tool.execute(
      'tool-parent',
      { parallel: [
        { description: 'first', prompt: 'a', subagent_type: 'explore' },
        { description: 'second', prompt: 'b', subagent_type: 'explore' },
      ] },
      undefined, undefined, context(harness.root),
    );
    await waitForPrompts(harness, 2);

    // The second child finishes FIRST — attribution must follow the task position regardless.
    harness.sessions[1].emit({
      type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: {},
    });
    harness.sessions[1].finish('second done');
    harness.sessions[0].finish('first done');
    await run;

    const events = throughParentStream(harness.notices) as any[];
    const byRef = new Map<string, string[]>();
    for (const event of events) {
      const list = byRef.get(event.subagent.parentToolUseId) ?? [];
      list.push(event.type);
      byRef.set(event.subagent.parentToolUseId, list);
    }
    assert.deepEqual([...byRef.keys()].sort(), ['tool-parent#0', 'tool-parent#1']);
    assert.deepEqual(byRef.get('tool-parent#1'), ['tool_use', 'assistant_text']);
    assert.deepEqual(byRef.get('tool-parent#0'), ['assistant_text']);
    const descriptions = new Map(events.map((event) => (
      [event.subagent.parentToolUseId, event.subagent.description]
    )));
    assert.equal(descriptions.get('tool-parent#0'), 'first');
    assert.equal(descriptions.get('tool-parent#1'), 'second');
  } finally {
    harness.cleanup();
  }
});

test('a session with no event sink still runs the subagent, just without attribution', async () => {
  // The sink is absent outside a Cortex-hosted session. Attribution is a nicety; the subagent
  // itself and its returned output must not depend on the sink existing.
  const harness = createHarness({ model: 'role-model' }, { attributed: false });
  try {
    const run = harness.tool.execute(
      'tool-parent', singleParams(), undefined, undefined, context(harness.root),
    );
    await waitForPrompts(harness, 1);
    harness.sessions[0].emit({
      type: 'tool_execution_start', toolCallId: 'c1', toolName: 'grep', args: {},
    });
    harness.sessions[0].finish('child answer');
    const result = await run;
    assert.match(result.content[0].text, /child answer/);
    assert.equal(harness.notices.length, 0);
  } finally {
    harness.cleanup();
  }
});
