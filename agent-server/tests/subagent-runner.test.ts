// input:  the backend-neutral orchestrator, the shared schema, and the daemon-side entry
// output: invocation validation, mode semantics, caps, failure isolation, backend precedence
// pos:    Tests backend-neutral subagent orchestration and dispatch
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { CONFIG_DIR } from '../src/core/paths.js';
import { Capability, CAPABILITIES_BY_BACKEND } from '../src/agent-adapter/capabilities.js';
import {
  buildToolResult, failedChildResult, isFailed, resultText, runInvocation,
} from '@core/agents/subagent/orchestrate.js';
import {
  MAX_SUBAGENT_CONCURRENCY, MAX_SUBAGENT_TASKS, resolveInvocation,
} from '@core/agents/subagent/schema.js';
import {
  _test as subagentRunnerTest, parseModelSpec, supportsSubagents,
} from '../src/domain/agents/subagent/runner.js';
import { profileRepo } from '../src/store/profile-repo.js';
import { emptyUsage } from '@core/agents/subagent/usage.js';
import type {
  RunChildFn, SubagentResult, SubagentTask,
} from '@core/agents/subagent/types.js';

// `service.ts` is the only thing that dispatches, so the dispatcher is what gets faked.
const runSubagent = vi.hoisted(() => vi.fn());
vi.mock('../src/domain/agents/subagent/runner.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runSubagent,
}));
const { startDaemonSubagentRun } = await import('../src/domain/agents/subagent/service.js');
const { _resetSubagentRuns, waitForSubagentRun } = await import(
  '../src/domain/agents/subagent/registry.js'
);

// --- helpers ---

/** `Promise.withResolvers` is newer than this package's `lib` target. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function task(overrides: Partial<SubagentTask> = {}): SubagentTask {
  return { description: 'd', prompt: 'p', subagent_type: 'general-purpose', ...overrides };
}

function ok(description: string, output = 'out'): SubagentResult {
  return { description, prompt: 'p', subagentType: 'general-purpose', output, usage: emptyUsage() };
}

function writeRole(name: string, frontmatter: string[] = []): void {
  const dir = path.join(CONFIG_DIR, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    ['---', `name: ${name}`, 'description: d', ...frontmatter, '---', 'body'].join('\n'),
  );
}

function withProfiles<T>(profiles: unknown, run: () => T): T {
  const file = path.join(CONFIG_DIR, 'profiles.json');
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(profiles));
    profileRepo.invalidate();
    return run();
  } finally {
    if (original === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, original);
    profileRepo.invalidate();
  }
}

beforeEach(() => {
  runSubagent.mockReset();
  _resetSubagentRuns();
  fs.rmSync(path.join(CONFIG_DIR, 'agents'), { recursive: true, force: true });
});

afterEach(() => { _resetSubagentRuns(); });

// --- model spec ---

test('parseModelSpec splits provider, model and thinking, each part optional', () => {
  assert.deepEqual(parseModelSpec('deepseek/deepseek-chat:high'),
    { provider: 'deepseek', model: 'deepseek-chat', thinking: 'high' });
  assert.deepEqual(parseModelSpec('claude-opus-4-6'), { model: 'claude-opus-4-6', thinking: undefined });
  assert.deepEqual(parseModelSpec('openai/gpt-5'), { provider: 'openai', model: 'gpt-5', thinking: undefined });
  assert.deepEqual(parseModelSpec('  '), {});
  assert.deepEqual(parseModelSpec(undefined), {});
});

test('parseModelSpec does not mistake the scheme colon of a lone model id for a thinking level', () => {
  // A leading colon is not a separator: `lastIndexOf(':') > 0` is the guard.
  assert.deepEqual(parseModelSpec(':weird'), { model: ':weird', thinking: undefined });
});

test('a cross-backend Claude child uses the Claude backend default, never the PI channel mode', () => {
  withProfiles({
    defaultProfile: 'pi-default',
    defaultProfileByBackend: { claude: 'claude-route' },
    profiles: {
      'pi-default': { model: 'pi-model', backend: 'pi', mode: 'deepseek', provider: 'deepseek' },
      'claude-first': { model: 'claude-first-model', backend: 'claude', mode: 'api' },
      'claude-route': { model: 'claude-default-model', backend: 'claude', mode: 'plan' },
    },
  }, () => {
    const request = {
      parent: {
        backend: 'pi', mode: 'deepseek', provider: 'deepseek', model: 'pi-parent-model',
        channel: 'web:pi',
      },
    } as any;
    const explicit = subagentRunnerTest.claudeChildConfig(
      request, parseModelSpec('claude-haiku-4-5'),
    );
    assert.equal(explicit.model, 'claude-haiku-4-5');
    assert.equal(explicit.mode, 'plan');

    const implicit = subagentRunnerTest.claudeChildConfig(request, {});
    assert.equal(implicit.model, 'claude-default-model');
    assert.equal(implicit.mode, 'plan');
  });
});

test('a Claude child keeps its Claude parent model and route', () => {
  const request = {
    parent: { backend: 'claude', model: 'parent-model', mode: null, channel: 'web:claude' },
  } as any;
  const config = subagentRunnerTest.claudeChildConfig(request, {});
  assert.equal(config.model, 'parent-model');
  assert.equal(config.mode, null);
});

test('a cross-backend Claude child fails clearly when no Claude profile can supply its route', () => {
  withProfiles({
    defaultProfile: 'pi-only',
    profiles: {
      'pi-only': { model: 'pi-model', backend: 'pi', mode: 'deepseek', provider: 'deepseek' },
    },
  }, () => {
    const request = {
      parent: { backend: 'pi', model: 'pi-model', mode: 'deepseek', channel: 'web:pi' },
    } as any;
    assert.throws(
      () => subagentRunnerTest.claudeChildConfig(request, parseModelSpec('claude-haiku-4-5')),
      /configured Claude profile for routing/,
    );
  });
});

// --- capability gate ---

test('both shipped backends declare the subagent capability, and the gate reads it', () => {
  assert.ok(CAPABILITIES_BY_BACKEND.claude.has(Capability.Subagents));
  assert.ok(CAPABILITIES_BY_BACKEND.pi.has(Capability.Subagents));
  assert.equal(supportsSubagents('claude'), true);
  assert.equal(supportsSubagents('pi'), true);
  assert.equal(supportsSubagents('gemini' as never), false);
});

// --- schema ---

test('resolveInvocation requires exactly one mode', () => {
  assert.equal(resolveInvocation(task()).mode, 'single');
  assert.equal(resolveInvocation({ parallel: [task()] }).mode, 'parallel');
  assert.equal(resolveInvocation({ chain: [task()] }).mode, 'chain');
  assert.throws(() => resolveInvocation({}), /exactly one Agent mode/);
  assert.throws(() => resolveInvocation({ ...task(), parallel: [task()] }), /exactly one Agent mode/);
  assert.throws(() => resolveInvocation({ parallel: [task()], chain: [task()] }), /exactly one Agent mode/);
});

test('resolveInvocation names the field that is missing', () => {
  assert.throws(() => resolveInvocation({ description: 'd', prompt: '', subagent_type: 't' }),
    /non-empty prompt/);
  assert.throws(() => resolveInvocation({ description: 'd', prompt: 'p', subagent_type: '  ' }),
    /non-empty subagent_type/);
});

test('resolveInvocation enforces the task cap and rejects an empty fan-out', () => {
  const many = Array.from({ length: MAX_SUBAGENT_TASKS + 1 }, () => task());
  assert.throws(() => resolveInvocation({ parallel: many }), new RegExp(`maximum is ${MAX_SUBAGENT_TASKS}`));
  assert.throws(() => resolveInvocation({ chain: [] }), /at least one task/);
  assert.doesNotThrow(() => resolveInvocation({ parallel: many.slice(0, MAX_SUBAGENT_TASKS) }));
});

test('resolveInvocation rejects a backend that is not a real one', () => {
  assert.throws(() => resolveInvocation(task({ backend: 'gpt' as never })), /backend must be "claude" or "pi"/);
  assert.equal(resolveInvocation(task({ backend: 'pi' })).tasks[0].backend, 'pi');
});

// --- modes ---

test('parallel runs every task and keeps results in task order, not completion order', async () => {
  const order = [0, 1, 2].map(() => deferred());
  const runChild: RunChildFn = async (t, index) => {
    await order[index].promise;
    return ok(t.description);
  };
  const tasks = ['a', 'b', 'c'].map(d => task({ description: d }));
  const pending = runInvocation({ mode: 'parallel', tasks }, runChild, undefined);
  // Settle backwards: if arrival order leaked into the result the list would come back reversed.
  order[2].resolve(); order[0].resolve(); order[1].resolve();
  const { details } = await pending;
  assert.deepEqual(details.results.map(r => r.description), ['a', 'b', 'c']);
});

test('parallel never runs more than the concurrency cap at once', async () => {
  let live = 0;
  let peak = 0;
  const gates = Array.from({ length: MAX_SUBAGENT_TASKS }, () => deferred());
  const runChild: RunChildFn = async (t, index) => {
    live++; peak = Math.max(peak, live);
    await gates[index].promise;
    live--;
    return ok(t.description);
  };
  const tasks = gates.map((_, i) => task({ description: `t${i}` }));
  const pending = runInvocation({ mode: 'parallel', tasks }, runChild, undefined);
  await new Promise(resolve => setImmediate(resolve));
  for (const gate of gates) gate.resolve();
  await pending;
  assert.ok(peak <= MAX_SUBAGENT_CONCURRENCY, `peak ${peak} <= ${MAX_SUBAGENT_CONCURRENCY}`);
  assert.equal(peak, Math.min(MAX_SUBAGENT_TASKS, MAX_SUBAGENT_CONCURRENCY));
});

test('one failing child does not fail its parallel siblings', async () => {
  const runChild: RunChildFn = async (t) => (
    t.description === 'b' ? failedChildResult(t, new Error('boom')) : ok(t.description)
  );
  const tasks = ['a', 'b', 'c'].map(d => task({ description: d }));
  const { content, details } = await runInvocation({ mode: 'parallel', tasks }, runChild, undefined);
  assert.deepEqual(details.results.map(isFailed), [false, true, false]);
  assert.match(content[0].text, /Parallel: 2\/3 succeeded/);
  assert.match(content[0].text, /### \[b\] failed/);
  assert.match(content[0].text, /boom/);
});

test('chain substitutes {previous} and stops at the first failure', async () => {
  const seen: string[] = [];
  const runChild: RunChildFn = async (t) => {
    seen.push(t.prompt);
    if (t.description === 'second') return failedChildResult(t, new Error('nope'));
    return ok(t.description, `${t.description}-output`);
  };
  const tasks = [
    task({ description: 'first', prompt: 'go' }),
    task({ description: 'second', prompt: 'use {previous} twice: {previous}' }),
    task({ description: 'third', prompt: 'never' }),
  ];
  const { details, content } = await runInvocation({ mode: 'chain', tasks }, runChild, undefined);
  assert.deepEqual(seen, ['go', 'use first-output twice: first-output']);
  assert.equal(details.results.length, 2);
  assert.match(content[0].text, /^Agent failed: nope/);
});

test('buildToolResult reports the last link for single and chain, and aggregates usage', () => {
  const withUsage = (description: string, cost: number): SubagentResult => ({
    ...ok(description), usage: { ...emptyUsage(), input: 10, cost },
  });
  const chain = buildToolResult('chain', [withUsage('a', 1), withUsage('b', 2)]);
  assert.equal(chain.content[0].text, 'out');
  assert.equal(chain.details.usage.input, 20);
  assert.equal(chain.details.usage.cost, 3);
  assert.equal(buildToolResult('single', [ok('a', '')]).content[0].text, '(no output)');
});

test('resultText prefers the error message once a result has failed', () => {
  const failed = failedChildResult(task(), new Error('exploded'));
  assert.equal(resultText(failed), 'exploded');
  assert.equal(failed.stopReason, 'error');
});

// --- daemon entry: precedence and validation ---

async function startAndSettle(request: Parameters<typeof startDaemonSubagentRun>[0]) {
  const view = startDaemonSubagentRun(request);
  await waitForSubagentRun(view.id, 5000);
  return view;
}

const parentIsClaude = { backend: 'claude' as const, channel: 'web:1', env: process.env };

test('backend precedence is task, then role, then the delegating parent', async () => {
  writeRole('general-purpose');
  writeRole('pi-role', ['backend: pi']);
  runSubagent.mockImplementation(async (req: any) => ok(req.task.description));

  await startAndSettle({
    params: {
      parallel: [
        task({ description: 'from-task', subagent_type: 'general-purpose', backend: 'pi' }),
        task({ description: 'from-role', subagent_type: 'pi-role' }),
        task({ description: 'from-parent', subagent_type: 'general-purpose' }),
      ],
    },
    background: false,
    cwd: '/tmp',
    parent: parentIsClaude,
    sessionId: 's1',
  });

  const byDescription = new Map<string, string>(
    runSubagent.mock.calls.map(([req]: any[]) => [req.task.description, req.backend]),
  );
  assert.equal(byDescription.get('from-task'), 'pi');
  assert.equal(byDescription.get('from-role'), 'pi');
  assert.equal(byDescription.get('from-parent'), 'claude');
});

test('a task-level backend overrides the role\'s own', async () => {
  writeRole('pi-role', ['backend: pi']);
  runSubagent.mockImplementation(async (req: any) => ok(req.task.description));
  await startAndSettle({
    params: task({ subagent_type: 'pi-role', backend: 'claude' }),
    background: false,
    cwd: '/tmp',
    parent: parentIsClaude,
    sessionId: 's1',
  });
  assert.equal(runSubagent.mock.calls[0][0].backend, 'claude');
});

test('each child gets its own attribution ref, keyed on the run id and its index', async () => {
  writeRole('general-purpose');
  runSubagent.mockImplementation(async (req: any) => ok(req.task.description));
  const view = await startAndSettle({
    params: { parallel: [task({ description: 'a' }), task({ description: 'b' })] },
    background: false,
    cwd: '/tmp',
    parent: parentIsClaude,
    sessionId: 's1',
  });
  const refs = runSubagent.mock.calls.map(([req]: any[]) => req.ref).sort();
  assert.deepEqual(refs, [`${view.id}#0`, `${view.id}#1`]);
});

test('an unknown role is refused before anything is registered — no half-run fan-out', () => {
  writeRole('general-purpose');
  assert.throws(
    () => startDaemonSubagentRun({
      params: { parallel: [task(), task({ subagent_type: 'ghost' })] },
      background: false,
      cwd: '/tmp',
      parent: parentIsClaude,
      sessionId: 's1',
    }),
    /Unknown subagent_type "ghost"/,
  );
  assert.equal(runSubagent.mock.calls.length, 0);
});

test('a child that throws is isolated into a failed result rather than failing the run', async () => {
  writeRole('general-purpose');
  runSubagent.mockImplementation(async (req: any) => {
    if (req.task.description === 'bad') throw new Error('child exploded');
    return ok(req.task.description);
  });
  const view = await startAndSettle({
    params: { parallel: [task({ description: 'good' }), task({ description: 'bad' })] },
    background: false,
    cwd: '/tmp',
    parent: parentIsClaude,
    sessionId: 's1',
  });
  const outcome = await waitForSubagentRun(view.id, 0);
  assert.equal(outcome!.view.status, 'completed');
  assert.match(outcome!.result!.content[0].text, /Parallel: 1\/2 succeeded/);
  assert.match(outcome!.result!.content[0].text, /child exploded/);
});
