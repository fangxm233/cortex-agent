// input:  PI subagent tool, stub child processes, temporary role files
// output: PI schema, spawn, failure, usage, and abort contracts
// pos:    Regression tests for the PI Agent subagent tool
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import {
  createSubagentTool,
  MAX_SUBAGENT_TASKS,
  type SubagentToolDeps,
} from '../src/agent-adapter/pi/subagent.js';

class StubChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killSignals.push(signal);
    return true;
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, any>;
  child: StubChild;
}

function createSpawner() {
  const calls: SpawnCall[] = [];
  const spawn = (command: string, args: string[], options: Record<string, any>) => {
    const child = new StubChild();
    calls.push({ command, args, options, child });
    return child as any;
  };
  return { calls, spawn };
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

function createHarness(role: { model?: string; tools?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-subagent-'));
  const agentDir = path.join(root, 'pi');
  writeRole(agentDir, 'explore', role);
  const spawner = createSpawner();
  const deps: SubagentToolDeps = {
    spawn: spawner.spawn as any,
    command: 'pi-test',
    agentDir,
    ensureRoles: () => undefined,
    toolShimsPath: '/extensions/tool-shims.js',
    mcpBridgePath: '/extensions/mcp-bridge.js',
    killGraceMs: 5_000,
  };
  return {
    root,
    calls: spawner.calls,
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
  terminal: { stopReason?: string; errorMessage?: string } = {},
) {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage,
      stopReason: terminal.stopReason ?? 'stop',
      ...(terminal.errorMessage ? { errorMessage: terminal.errorMessage } : {}),
    },
  };
}

function finish(child: StubChild, text = 'done', usage: Record<string, unknown> = {}): void {
  child.stdout.write(`${JSON.stringify(assistantEvent(text, usage))}\n`);
  child.emit('close', 0);
}

async function waitForCalls(calls: SpawnCall[], count: number): Promise<void> {
  await vi.waitFor(() => assert.equal(calls.length, count));
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('Agent schema exposes bounded provider/model choices and fallback precedence', () => {
  const models = [
    { provider: 'openai-codex', id: 'gpt-5.6-sol' },
    { provider: 'deepseek', id: 'deepseek-v4-flash' },
    { provider: 'openai-codex', id: 'gpt-5.6-sol' },
  ];
  const tool = (createSubagentTool as any)(undefined, models);
  const properties = (tool.parameters as any).properties;

  assert.match(tool.description, /deepseek\/deepseek-v4-flash/);
  assert.match(tool.description, /openai-codex\/gpt-5\.6-sol/);
  assert.equal(tool.description.match(/openai-codex\/gpt-5\.6-sol/g)?.length, 1);
  for (const schema of [
    properties.model,
    properties.parallel.items.properties.model,
    properties.chain.items.properties.model,
  ]) {
    assert.match(schema.description, /provider\/model/);
    assert.match(schema.description, /role.*current.*PI default/i);
  }

  const manyModels = Array.from({ length: 80 }, (_, index) => ({
    provider: 'provider',
    id: `model-${String(index).padStart(3, '0')}`,
  }));
  const bounded = (createSubagentTool as any)(undefined, manyModels).description;
  assert.match(bounded, /\+\d+ more/);
  assert.ok(bounded.length <= 1_500, `description is ${bounded.length} characters`);

  const overlong = (createSubagentTool as any)(undefined, [
    { provider: 'a', id: 'x'.repeat(1_300) },
    { provider: 'z', id: 'short-model' },
  ]).description;
  assert.match(overlong, /z\/short-model/);
  assert.doesNotMatch(overlong, /overrides:\s+\(\+/);
});

test('single child uses JSON/no-session extensions, strips thread env, and returns usage', async () => {
  const harness = createHarness({ model: 'role-model', tools: 'read, grep' });
  const previousThread = process.env.CORTEX_THREAD_ID;
  const previousTask = process.env.CORTEX_TASK_ID;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.CORTEX_THREAD_ID = 'thr_parent';
  process.env.CORTEX_TASK_ID = 'task_parent';
  process.env.PI_CODING_AGENT_DIR = harness.root;
  try {
    const run = harness.tool.execute(
      'tool-1',
      singleParams({ model: 'explicit-model' }),
      undefined,
      undefined,
      context(harness.root, { id: 'parent-model', provider: 'parent-provider' }),
    );
    await waitForCalls(harness.calls, 1);
    const call = harness.calls[0];
    assert.equal(call.command, 'pi-test');
    assert.deepEqual(call.args.slice(0, 4), ['--mode', 'json', '-p', '--no-session']);
    assert.equal(argValue(call.args, '--model'), 'explicit-model');
    assert.equal(call.args.includes('--provider'), false);
    assert.equal(argValue(call.args, '--tools'), 'read,grep');
    assert.equal(call.args.includes('--no-extensions'), true);
    assert.equal(call.args.includes('-e'), false);
    assert.deepEqual(
      call.args.flatMap((arg, index) => (
        arg === '--extension' ? [arg, call.args[index + 1]] : []
      )),
      [
        '--extension', '/extensions/tool-shims.js',
        '--extension', '/extensions/mcp-bridge.js',
      ],
    );
    assert.equal(call.options.env.CORTEX_PI_SUBAGENT, '1');
    assert.equal(call.options.env.CORTEX_THREAD_ID, undefined);
    assert.equal(call.options.env.CORTEX_TASK_ID, undefined);
    assert.equal(call.options.env.PI_CODING_AGENT_DIR, path.join(harness.root, 'pi'));

    finish(call.child, 'child answer', {
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
  } finally {
    if (previousThread === undefined) delete process.env.CORTEX_THREAD_ID;
    else process.env.CORTEX_THREAD_ID = previousThread;
    if (previousTask === undefined) delete process.env.CORTEX_TASK_ID;
    else process.env.CORTEX_TASK_ID = previousTask;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
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
    await waitForCalls(harness.calls, 1);
    assert.equal(argValue(harness.calls[0].args, '--model'), 'role-model');
    assert.equal(harness.calls[0].args.includes('--provider'), false);
    finish(harness.calls[0].child);
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
    await waitForCalls(harness.calls, 1);
    assert.equal(argValue(harness.calls[0].args, '--provider'), 'parent-provider');
    assert.equal(argValue(harness.calls[0].args, '--model'), 'parent-model');
    finish(harness.calls[0].child);
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
    await waitForCalls(harness.calls, 1);
    assert.equal(harness.calls[0].args.includes('--provider'), false);
    assert.equal(harness.calls[0].args.includes('--model'), false);
    finish(harness.calls[0].child);
    await run;
  } finally {
    harness.cleanup();
  }
});

test('NDJSON parser accepts split chunks and a final unterminated record', async () => {
  const harness = createHarness();
  try {
    const run = harness.tool.execute(
      'tool-5', singleParams(), undefined, undefined, context(harness.root),
    );
    await waitForCalls(harness.calls, 1);
    const encoded = JSON.stringify(assistantEvent('split output', { input: 3, output: 2 }));
    harness.calls[0].child.stdout.write(encoded.slice(0, 13));
    harness.calls[0].child.stdout.write(encoded.slice(13));
    harness.calls[0].child.emit('close', 0);
    const result = await run;
    assert.equal(result.content[0].text, 'split output');
    assert.equal(result.details.usage.input, 3);
    assert.equal(result.details.usage.output, 2);
  } finally {
    harness.cleanup();
  }
});

test('later successful retry replaces stale assistant terminal error state', async () => {
  const harness = createHarness();
  try {
    const run = harness.tool.execute(
      'tool-5b', singleParams(), undefined, undefined, context(harness.root),
    );
    await waitForCalls(harness.calls, 1);
    const child = harness.calls[0].child;
    child.stdout.write(`${JSON.stringify(assistantEvent(
      'failed attempt',
      {},
      { stopReason: 'error', errorMessage: 'stale provider error' },
    ))}\n`);
    child.stdout.write(`${JSON.stringify(assistantEvent('recovered answer'))}\n`);
    child.emit('close', 0);
    const result = await run;
    assert.equal(result.content[0].text, 'recovered answer');
    assert.equal(result.details.results[0].stopReason, 'stop');
    assert.equal(result.details.results[0].errorMessage, undefined);
  } finally {
    harness.cleanup();
  }
});

test('signal-terminated child is a failed result outside caller abort', async () => {
  const harness = createHarness();
  try {
    const run = harness.tool.execute(
      'tool-5c', singleParams(), undefined, undefined, context(harness.root),
    );
    await waitForCalls(harness.calls, 1);
    harness.calls[0].child.emit('close', null, 'SIGKILL');
    const result = await run;
    assert.equal(result.details.results[0].exitCode, 1);
    assert.equal(result.details.results[0].stopReason, 'error');
    assert.match(result.content[0].text, /Agent failed: .*SIGKILL/i);
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
    await waitForCalls(harness.calls, MAX_SUBAGENT_TASKS);
    for (let index = harness.calls.length - 1; index >= 0; index -= 1) {
      finish(harness.calls[index].child, `answer ${index}`, { input: 1, output: 2 });
    }
    const result = await run;
    assert.equal(result.details.mode, 'parallel');
    assert.deepEqual(
      result.details.results.map((entry: any) => entry.output),
      Array.from({ length: MAX_SUBAGENT_TASKS }, (_, index) => `answer ${index}`),
    );
    assert.equal(result.details.usage.input, MAX_SUBAGENT_TASKS);
    assert.equal(result.details.usage.output, MAX_SUBAGENT_TASKS * 2);
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
    await waitForCalls(harness.calls, 2);
    finish(harness.calls[0].child, 'one', { totalTokens: 10 });
    finish(harness.calls[1].child, 'two', { totalTokens: 20 });
    const result = await run;
    assert.equal(result.details.results[0].usage.contextTokens, 10);
    assert.equal(result.details.results[1].usage.contextTokens, 20);
    assert.equal(result.details.usage.contextTokens, 30);
  } finally {
    harness.cleanup();
  }
});

test('mode and required-field validation rejects before spawning', async () => {
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

test('parallel validates every role before spawning any child', async () => {
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

test('parallel child spawn error becomes a failed result and awaits siblings', async () => {
  const harness = createHarness();
  try {
    const run = harness.tool.execute('tool-6g', {
      parallel: [
        { description: 'Broken', prompt: 'Fail', subagent_type: 'explore' },
        { description: 'Healthy', prompt: 'Finish', subagent_type: 'explore' },
      ],
    }, undefined, undefined, context(harness.root));
    await waitForCalls(harness.calls, 2);
    let settled = false;
    const observed = run.then(
      (result: any) => ({ result }),
      (error: unknown) => ({ error }),
    ).finally(() => { settled = true; });
    harness.calls[0].child.emit('error', new Error('spawn failed'));
    await new Promise((resolve) => setImmediate(resolve));
    const settledBeforeSibling = settled;
    finish(harness.calls[1].child, 'healthy answer');
    const outcome = await observed;
    assert.equal(settledBeforeSibling, false);
    assert.equal('error' in outcome, false);
    assert.match(outcome.result.content[0].text, /Parallel: 1\/2 succeeded/);
    assert.equal(outcome.result.details.results[0].stopReason, 'error');
    assert.match(outcome.result.details.results[0].errorMessage, /spawn failed/);
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
    await waitForCalls(harness.calls, 1);
    assert.match(harness.calls[0].args.at(-1)!, /Task: Inspect\./);
    finish(harness.calls[0].child, 'first result');
    await waitForCalls(harness.calls, 2);
    assert.match(harness.calls[1].args.at(-1)!, /Task: Summarize first result/);
    finish(harness.calls[1].child, 'second result');
    const result = await run;
    assert.equal(result.content[0].text, 'second result');
    assert.equal(result.details.mode, 'chain');
  } finally {
    harness.cleanup();
  }
});

test('non-zero child exit returns a failed Agent result', async () => {
  const harness = createHarness();
  try {
    const run = harness.tool.execute(
      'tool-8b', singleParams(), undefined, undefined, context(harness.root),
    );
    await waitForCalls(harness.calls, 1);
    harness.calls[0].child.stderr.write('child process failed');
    harness.calls[0].child.emit('close', 7);
    const result = await run;
    assert.equal(result.details.results[0].exitCode, 7);
    assert.equal(result.content[0].text, 'Agent failed: child process failed');
  } finally {
    harness.cleanup();
  }
});

test('chain stops after a terminal assistant error before spawning the next task', async () => {
  const harness = createHarness();
  try {
    const run = harness.tool.execute('tool-8c', {
      chain: [
        { description: 'First', prompt: 'Fail.', subagent_type: 'explore' },
        { description: 'Second', prompt: 'Never run {previous}', subagent_type: 'explore' },
      ],
    }, undefined, undefined, context(harness.root));
    await waitForCalls(harness.calls, 1);
    harness.calls[0].child.stdout.write(`${JSON.stringify(assistantEvent(
      'failed response',
      {},
      { stopReason: 'error', errorMessage: 'provider rejected request' },
    ))}\n`);
    harness.calls[0].child.emit('close', 0);
    const result = await run;
    assert.equal(harness.calls.length, 1);
    assert.equal(result.details.results.length, 1);
    assert.equal(result.content[0].text, 'Agent failed: provider rejected request');
  } finally {
    harness.cleanup();
  }
});

test('abort sends SIGTERM then SIGKILL when a child remains open', async () => {
  vi.useFakeTimers();
  const harness = createHarness();
  const controller = new AbortController();
  try {
    const run = harness.tool.execute(
      'tool-9', singleParams(), controller.signal, undefined, context(harness.root),
    );
    await vi.waitFor(() => assert.equal(harness.calls.length, 1));
    controller.abort();
    assert.deepEqual(harness.calls[0].child.killSignals, ['SIGTERM']);
    await vi.advanceTimersByTimeAsync(5_000);
    assert.deepEqual(harness.calls[0].child.killSignals, ['SIGTERM', 'SIGKILL']);
    harness.calls[0].child.emit('close', null);
    await assert.rejects(run, /aborted/i);
  } finally {
    harness.cleanup();
  }
});

test('parallel abort propagates to every active child', async () => {
  vi.useFakeTimers();
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
    await vi.waitFor(() => assert.equal(harness.calls.length, MAX_SUBAGENT_TASKS));
    controller.abort();
    for (const call of harness.calls) assert.deepEqual(call.child.killSignals, ['SIGTERM']);
    await vi.advanceTimersByTimeAsync(5_000);
    for (const call of harness.calls) {
      assert.deepEqual(call.child.killSignals, ['SIGTERM', 'SIGKILL']);
      call.child.emit('close', null);
    }
    await assert.rejects(run, /aborted/i);
  } finally {
    harness.cleanup();
  }
});
