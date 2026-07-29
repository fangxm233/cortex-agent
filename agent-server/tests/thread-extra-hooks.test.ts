// input:  thread runner, HookBus registry entries, scoped hooks
// output: lifecycle payload and scoped/per-call regressions
// pos:    Verifies thread lifecycle hooks share the HookBus execution path
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const agent = vi.hoisted(() => ({ runAgent: vi.fn() }));

vi.mock('@domain/agents/index.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    runAgent: agent.runAgent,
    getActiveBackend: () => 'claude',
    getActiveProfile: () => 'default',
    getClaudeMode: () => 'api',
  };
});

import { CONFIG_DIR, DATA_DIR, DEFAULTS_DIR, PROJECTS_DIR } from '../src/core/paths.js';
import { initHookBus } from '../src/core/hook-bus.js';
import { threadStore } from '../src/store/thread-repo.js';
import {
  cleanupWorkspace,
  createThread,
  getTemplate,
  loadConfig,
} from '../src/domain/threads/index.js';
import {
  resumeThread,
  runThread,
} from '../src/domain/threads/runner.js';
import * as throttle from '../src/domain/costs/rate-limit-throttle.js';
import * as resumeRegistry from '../src/domain/costs/resume-registry.js';
import { MockAdapter } from '../src/platform/testing.js';
import type { HookEntry } from '../src/store/hook-registry.js';
import type {
  HookResult,
  RunThreadOptions,
  ThreadHookConfig,
  ThreadRecord,
} from '../src/core/types/thread-types.js';

const createdThreadIds = new Set<string>();
let tmpRoot: string;

function writeThreadConfig(): void {
  const agentConfig = (name: string, persistSession = true) => ({
    name,
    profile: '__active__',
    persistSession,
    promptTemplate: '{{input}}',
  });
  const config = {
    agents: {
      alpha: agentConfig('alpha'),
      beta: agentConfig('beta'),
    },
    templates: {
      lifecycle: {
        name: 'lifecycle',
        description: 'two-step lifecycle fixture',
        agents: ['alpha', 'beta'],
        transitions: [{ from: 'alpha', to: 'beta', condition: { type: 'always' } }],
        entryAgent: 'alpha',
        maxTotalSteps: 3,
      },
      suspend: {
        name: 'suspend',
        description: 'single-agent suspension fixture',
        agents: ['alpha'],
        transitions: [],
        entryAgent: 'alpha',
        maxTotalSteps: 4,
      },
      scoped: {
        name: 'scoped',
        description: 'template hook fixture',
        agents: ['alpha'],
        transitions: [],
        entryAgent: 'alpha',
        maxTotalSteps: 3,
      },
    },
  };
  const configRoot = path.join(CONFIG_DIR, 'thread-templates');
  for (const [kind, entries] of Object.entries({
    agents: config.agents,
    templates: config.templates,
  })) {
    const directory = path.join(configRoot, kind);
    fs.mkdirSync(directory, { recursive: true });
    for (const [name, value] of Object.entries(entries)) {
      fs.writeFileSync(path.join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
    }
  }
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-lifecycle-hooks-'));
  writeThreadConfig();
  loadConfig();
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  agent.runAgent.mockReset();
  initHookBus({ entries: [], hooksDir: tmpRoot });
  throttle._testReset();
  resumeRegistry._testReset();
  for (const name of ['lifecycle', 'suspend', 'scoped']) {
    const template = getTemplate(name);
    if (template) delete template.hooks;
  }
});

afterEach(async () => {
  throttle._testReset();
  resumeRegistry._testReset();
  initHookBus({ entries: [], hooksDir: tmpRoot });
  for (const id of createdThreadIds) {
    const thread = threadStore.get(id);
    if (thread?.workspacePath) {
      try { cleanupWorkspace(id); } catch {}
    }
    await threadStore.delete(id);
  }
  createdThreadIds.clear();
  await threadStore.flush();
});

function track(thread: ThreadRecord): ThreadRecord {
  createdThreadIds.add(thread.id);
  return thread;
}

function createTestThread(
  templateName: string,
  metadata: NonNullable<ThreadRecord['metadata']> = {},
): ThreadRecord {
  return track(createThread('C-lifecycle-hooks', {
    templateName,
    userMessage: 'perform lifecycle test',
    userMessageTs: String(Date.now()),
    projectId: 'atlas-project',
    metadata,
  }));
}

function makeOptions(channel: string): RunThreadOptions {
  return {
    adapter: new MockAdapter(),
    channel,
    destination: { type: 'interactive-reply', conduit: channel, sessionId: '' },
    threadAnchorId: null,
    statusMsg: null,
    startTime: Date.now(),
    onProgress: null,
  };
}

function result(sessionId: string, output = 'done') {
  return {
    sessionId,
    finalOutput: output,
    total_cost_usd: 0,
    num_turns: 1,
  };
}

function handle(value: Record<string, unknown>, beforeResolve?: () => Promise<void>) {
  return {
    promise: (async () => {
      await beforeResolve?.();
      return value;
    })(),
    kill: () => true,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
    agentProcess: undefined,
  };
}

function queueAgentResult(value: Record<string, unknown>, beforeResolve?: () => Promise<void>): void {
  agent.runAgent.mockImplementationOnce(() => handle(value, beforeResolve));
}

function writeCaptureScript(filename: string, capturePath: string, hookResult: HookResult = { insertAgent: false }): string {
  const scriptPath = path.join(tmpRoot, filename);
  fs.writeFileSync(scriptPath, [
    '#!/usr/bin/env node',
    'import { appendFileSync } from "node:fs";',
    'let input = "";',
    'for await (const chunk of process.stdin) input += chunk;',
    `appendFileSync(${JSON.stringify(capturePath)}, input + "\\n");`,
    `process.stdout.write(${JSON.stringify(JSON.stringify(hookResult))});`,
    '',
  ].join('\n'), { mode: 0o644 });
  return scriptPath;
}

function writeResultScript(filename: string, hookResult: HookResult): string {
  const scriptPath = path.join(tmpRoot, filename);
  fs.writeFileSync(scriptPath, [
    '#!/usr/bin/env node',
    'for await (const _chunk of process.stdin) {}',
    `process.stdout.write(${JSON.stringify(JSON.stringify(hookResult))});`,
    '',
  ].join('\n'), { mode: 0o644 });
  return scriptPath;
}

function writeTaggedCaptureScript(filename: string, capturePath: string, tag: string): string {
  const scriptPath = path.join(tmpRoot, filename);
  fs.writeFileSync(scriptPath, [
    '#!/usr/bin/env node',
    'import { appendFileSync } from "node:fs";',
    'let input = "";',
    'for await (const chunk of process.stdin) input += chunk;',
    'const payload = JSON.parse(input);',
    `appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ tag: ${JSON.stringify(tag)}, payload }) + "\\n");`,
    'process.stdout.write(JSON.stringify({ insertAgent: false }));',
    '',
  ].join('\n'), { mode: 0o644 });
  return scriptPath;
}

function captures(capturePath: string): Array<Record<string, any>> {
  if (!fs.existsSync(capturePath)) return [];
  return fs.readFileSync(capturePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function registryEntry(id: string, event: HookEntry['event'], script: string): HookEntry {
  return {
    id,
    event,
    run: { script },
    result: 'hook-result',
  };
}

test('runThread emits start, transition, and end with the complete lifecycle payload', async () => {
  const capturePath = path.join(tmpRoot, 'all-phases.jsonl');
  const script = path.basename(writeCaptureScript('all-phases.mjs', capturePath));
  initHookBus({
    entries: [
      registryEntry('thread-start', 'cortex:thread.start', script),
      registryEntry('thread-transition', 'cortex:thread.transition', script),
      registryEntry('thread-end', 'cortex:thread.end', script),
    ],
    hooksDir: tmpRoot,
  });
  const thread = createTestThread('lifecycle', {
    trigger: 'task-dispatch',
    taskId: 'a1b2',
    taskProject: 'atlas-tasks',
  });
  queueAgentResult(result('backend-alpha', 'alpha done'));
  queueAgentResult(result('backend-beta', 'beta done'));

  const run = await runThread(thread.id, makeOptions(thread.channel));

  assert.equal(run.thread.status, 'completed');
  const payloads = captures(capturePath);
  assert.deepEqual(payloads.map((payload) => payload.phase), ['start', 'transition', 'end']);
  assert.deepEqual(payloads.map((payload) => payload.previousAgent), [null, 'alpha', 'beta']);
  assert.deepEqual(payloads.map((payload) => payload.activeAgent), ['alpha', 'beta', 'beta']);
  for (const payload of payloads) {
    assert.equal(payload.threadId, thread.id);
    assert.equal(payload.templateName, 'lifecycle');
    assert.equal(payload.source, 'task-dispatch');
    assert.equal(payload.project, 'atlas-tasks');
    assert.equal(payload.projectId, 'atlas-project');
    assert.equal(payload.taskId, 'a1b2');
    assert.equal(payload.taskProject, 'atlas-tasks');
    assert.equal(payload.userMessage, 'perform lifecycle test');
    assert.equal(typeof payload.currentStepIndex, 'number');
    assert.ok(Array.isArray(payload.steps));
    assert.equal(typeof payload.artifactContent, 'string');
    assert.equal(typeof payload.totalCostUsd, 'number');
    assert.equal(payload.pendingControlAction, null);
  }
});

test('dispatch end hook skips suspension and runs once after resume with task identity', async () => {
  const capturePath = path.join(tmpRoot, 'status-check.jsonl');
  const script = path.basename(writeCaptureScript('task-status-check.mjs', capturePath));
  initHookBus({
    entries: [{
      ...registryEntry('task-status-check', 'cortex:thread.end', script),
      matcher: { source: 'task-dispatch' },
    }],
    hooksDir: tmpRoot,
  });
  const child = createTestThread('suspend');
  const parent = createTestThread('suspend', {
    trigger: 'task-dispatch',
    taskId: 'c3d4',
    taskProject: 'orchard',
    waitingOn: [child.id],
    childThreadIds: [child.id],
  });
  queueAgentResult(result('backend-parent-1'), async () => {
    await threadStore.mutate(parent.id, (record) => {
      (record.metadata ??= {}).pendingControl = {
        action: 'wait',
        onThreads: [child.id],
        onTasks: null,
      };
    });
  });

  const suspended = await runThread(parent.id, makeOptions(parent.channel));

  assert.equal(suspended.thread.status, 'waiting');
  assert.deepEqual(captures(capturePath), []);

  await threadStore.mutate(child.id, (record) => {
    record.status = 'completed';
    record.endedAt = new Date().toISOString();
  });
  await threadStore.mutate(parent.id, (record) => {
    (record.metadata ??= {}).waitingOn = [];
  });
  queueAgentResult(result('backend-parent-2'));

  const resumed = await resumeThread(parent.id, makeOptions(parent.channel));

  assert.equal(resumed.thread.status, 'completed');
  const payloads = captures(capturePath);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].source, 'task-dispatch');
  assert.equal(payloads[0].project, 'orchard');
  assert.equal(payloads[0].projectId, 'atlas-project');
  assert.equal(payloads[0].taskProject, 'orchard');
  assert.equal(payloads[0].taskId, 'c3d4');
});

test('dispatch end hook does not run while the thread is rate limited', async (t) => {
  t.onTestFinished(() => {
    throttle._testReset();
    resumeRegistry._testReset();
  });
  await throttle.initRateLimitThrottle(new MockAdapter({ adminChannel: 'admin' }) as any, {
    save: async () => {},
    load: async () => null,
  });
  await throttle.handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.99, resetsAt: Math.floor(Date.now() / 1000) + 3000 },
    { provider: 'provider-a', displayName: 'Provider A', mode: 'plan' },
  );
  const capturePath = path.join(tmpRoot, 'rate-limit-end.jsonl');
  const script = path.basename(writeCaptureScript('rate-limit-end.mjs', capturePath));
  initHookBus({
    entries: [registryEntry('thread-end', 'cortex:thread.end', script)],
    hooksDir: tmpRoot,
  });
  const thread = createTestThread('suspend', {
    trigger: 'task-dispatch',
    taskId: 'e5f6',
    taskProject: 'orchard',
  });
  queueAgentResult({ rateLimited: true, rateLimitProvider: 'provider-a' });

  const paused = await runThread(thread.id, makeOptions(thread.channel));

  assert.equal(paused.thread.status, 'rate_limited');
  assert.deepEqual(captures(capturePath), []);
});

function setScopedEndHook(resultValue: HookResult): void {
  const template = getTemplate('scoped');
  assert.ok(template);
  const scriptPath = writeResultScript('scoped-result.mjs', resultValue);
  template.hooks = {
    onEnd: { command: `node ${scriptPath}`, timeout: 1_000 },
  };
}

test('template-scoped onEnd HookResult inserts a hook agent', async () => {
  setScopedEndHook({ insertAgent: true, prompt: 'inserted follow-up', profile: '__active__' });
  const thread = createTestThread('scoped');
  queueAgentResult(result('backend-alpha'));
  queueAgentResult(result('backend-hook'));

  await runThread(thread.id, makeOptions(thread.channel));

  assert.equal(agent.runAgent.mock.calls.length, 2);
  assert.equal(agent.runAgent.mock.calls[1][0], 'inserted follow-up');
  assert.equal(agent.runAgent.mock.calls[1][1].sessionId, null);
  assert.match(agent.runAgent.mock.calls[1][1].sessionKey, /hook:end$/);
  assert.equal(threadStore.get(thread.id)?.steps.at(-1)?.agentSlotId, 'hook:end');
});

test('template-scoped onEnd HookResult targets the existing agent session', async () => {
  setScopedEndHook({ insertAgent: false, targetAgent: 'alpha', prompt: 'targeted follow-up' });
  const thread = createTestThread('scoped');
  queueAgentResult(result('backend-alpha'));
  queueAgentResult(result('backend-target'));

  await runThread(thread.id, makeOptions(thread.channel));

  assert.equal(agent.runAgent.mock.calls.length, 2);
  assert.equal(agent.runAgent.mock.calls[1][0], 'targeted follow-up');
  assert.equal(agent.runAgent.mock.calls[1][1].sessionId, 'backend-alpha');
  assert.match(agent.runAgent.mock.calls[1][1].sessionKey, /:alpha$/);
  assert.equal(threadStore.get(thread.id)?.steps.at(-1)?.agentSlotId, 'alpha');
});

test('template-scoped onEnd does not leak to another template', async () => {
  setScopedEndHook({ insertAgent: true, prompt: 'must stay scoped' });
  const thread = createTestThread('suspend');
  queueAgentResult(result('backend-alpha'));

  await runThread(thread.id, makeOptions(thread.channel));

  assert.equal(agent.runAgent.mock.calls.length, 1);
});

function writeClaimedTask(project: string, taskId: string): void {
  const projectDir = path.join(PROJECTS_DIR, project);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'TASKS.yaml'), [
    'tasks:',
    `  - id: "${taskId}"`,
    '    text: Hook payload fixture',
    '    why: ""',
    '    done-when: ""',
    '    priority: medium',
    '    status: open',
    '    template: scoped',
    '    plan: ""',
    '    claimed-by: worker',
    '',
  ].join('\n'));
}

function runStatusCheck(payload: Record<string, unknown>, argv: string[]): Record<string, unknown> {
  const script = path.join(DEFAULTS_DIR, 'hooks', 'task-status-check.mjs');
  const child = spawnSync(process.execPath, [script, ...argv], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CORTEX_ROOT: path.join(tmpRoot, 'cortex-root') },
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('task status script takes project and taskId from the lifecycle payload before argv', () => {
  writeClaimedTask('payload-project', 'f7a8');

  const hookResult = runStatusCheck({
    project: 'payload-project',
    projectId: 'fallback-project',
    taskProject: 'payload-project',
    taskId: 'f7a8',
    previousAgent: 'alpha',
  }, ['wrong-project', 'ffff']);

  assert.equal(hookResult.targetAgent, 'alpha');
  assert.match(String(hookResult.prompt), /f7a8/);
  assert.match(String(hookResult.prompt), /payload-project/);
});

test('task status script keeps argv as a fallback', () => {
  writeClaimedTask('argv-project', 'b9c0');

  const hookResult = runStatusCheck({ previousAgent: 'alpha' }, ['argv-project', 'b9c0']);

  assert.equal(hookResult.targetAgent, 'alpha');
  assert.match(String(hookResult.prompt), /b9c0/);
  assert.match(String(hookResult.prompt), /argv-project/);
});

test('task status script finds cortex-run state under the data directory', () => {
  writeClaimedTask('running-project', 'd1e2');
  const stateDir = path.join(DATA_DIR, 'tmp', 'cortex-run', 'active-run');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({
    task_project: 'running-project',
    task_id: 'd1e2',
    status: 'running',
    pid: process.pid,
  }));

  const hookResult = runStatusCheck({
    project: 'running-project',
    taskId: 'd1e2',
    previousAgent: 'alpha',
  }, []);

  assert.match(String(hookResult.prompt), /Auto-detected/);
  assert.match(String(hookResult.prompt), /active-run/);
});

function configureOrderedHooks(capturePath: string): RunThreadOptions {
  const hook = (tag: string): ThreadHookConfig => ({
    command: `node ${writeTaggedCaptureScript(`${tag}.mjs`, capturePath, tag)}`,
    timeout: 1_000,
  });
  const template = getTemplate('lifecycle');
  assert.ok(template);
  template.hooks = {
    onStart: hook('template-start'),
    onTransition: hook('template-transition'),
    onEnd: hook('template-end'),
  };
  const options = makeOptions('C-extra-runtime');
  options.extraHooks = {
    onStart: hook('extra-start'),
    onTransition: hook('extra-transition'),
    onEnd: hook('extra-end'),
  };
  return options;
}

function assertOrderedHookCaptures(observed: Array<Record<string, any>>, thread: ThreadRecord): void {
  assert.deepEqual(observed.map(({ tag }) => tag), [
    'template-start', 'extra-start',
    'template-transition', 'extra-transition',
    'template-end', 'extra-end',
  ]);
  assert.deepEqual(observed.map(({ payload }) => payload.phase), [
    'start', 'start', 'transition', 'transition', 'end', 'end',
  ]);
  for (const { payload } of observed) {
    assert.equal(payload.threadId, thread.id);
    assert.equal(payload.templateName, 'lifecycle');
    assert.equal(payload.project, 'extra-hooks-project');
    assert.equal(payload.taskId, 'e3f4');
  }
}

test('runThread executes per-call extraHooks after template hooks for every phase', async () => {
  const capturePath = path.join(tmpRoot, 'scoped-order.jsonl');
  const options = configureOrderedHooks(capturePath);
  const thread = createTestThread('lifecycle', {
    trigger: 'manual', taskId: 'e3f4', taskProject: 'extra-hooks-project',
  });
  queueAgentResult(result('backend-alpha', 'alpha done'));
  queueAgentResult(result('backend-beta', 'beta done'));

  await runThread(thread.id, options);

  assertOrderedHookCaptures(captures(capturePath), thread);
});

// Compile-time contract: callers may still supply generic per-call lifecycle hooks.
test('RunThreadOptions.extraHooks remains optional and phase-scoped', () => {
  const hookConfig: ThreadHookConfig = { command: 'true' };
  const options = makeOptions('C-extra');
  options.extraHooks = { onStart: hookConfig, onTransition: hookConfig, onEnd: hookConfig };
  assert.equal(options.extraHooks.onEnd, hookConfig);
});
