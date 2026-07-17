// input:  Node test runner + task-callback handler (DR-0011 §4.4)
// output: task-callback handler unit tests: idempotency, skipVerify, ghost callback, blockTask note
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { PROJECTS_DIR } from '../src/core/paths.js';
import { parse as yamlParse } from 'yaml';
import {
  startClientManager,
  stopClientManager,
} from '../src/domain/remote/client-manager.js';
import { registerDispatchExecution, getExecutionByTaskId } from '../src/domain/executions/registry.js';

// ── Helpers ──

// The client-manager WS now enforces a bearer token on the upgrade handshake.
const WS_TOKEN = 'test-ws-token';
process.env.CORTEX_CLIENT_TOKEN = WS_TOKEN;
const authHeaders = { 'x-cortex-token': WS_TOKEN };

function findEphemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = new WebSocketServer({ port: 0 });
    probe.on('listening', () => {
      const addr = probe.address();
      if (typeof addr === 'object' && addr) {
        const port = addr.port;
        probe.close(() => resolve(port));
      } else {
        reject(new Error('WebSocketServer address() did not return an object'));
      }
    });
    probe.on('error', reject);
  });
}

function makeRepo(project: string, content: string): { tasksPath: string; cleanup: () => void } {
  const projectDir = path.join(PROJECTS_DIR, project);
  fs.mkdirSync(projectDir, { recursive: true });
  const tasksPath = path.join(projectDir, 'TASKS.yaml');
  fs.writeFileSync(tasksPath, content);
  return {
    tasksPath,
    cleanup: () => {
      try { fs.unlinkSync(tasksPath); } catch {}
      try { fs.rmdirSync(projectDir); } catch {}
    },
  };
}

function findTaskInYaml(tasks: any[], id: string): any {
  return tasks.find((t: any) => t.id === id);
}

const P = '_test_cb_';
let testCounter = 0;
function nextProject(): string { return `${P}${++testCounter}`; }

const BASE_TASK_YAML = (id: string) => `tasks:
  - id: ${id}
    text: "Test task"
    why: "testing"
    done-when: ""
    priority: medium
    status: open
    template: coder-review
    plan: ""
`;

// ── Tests ──

test('no task linkage — sends ack ok:true when taskProject is null', async (t) => {
  const port = await findEphemeralPort();
  startClientManager(port);
  t.onTestFinished(() => stopClientManager());

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: authHeaders });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const ackPromise = new Promise<any>((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });

  ws.send(JSON.stringify({
    type: 'task-callback',
    device: 'test-device',
    callbackId: 'test:none:none',
    name: 'test-run',
    taskProject: null,
    taskId: null,
  }));

  const ack = await ackPromise;
  assert.equal(ack.type, 'task-callback-ack');
  assert.equal(ack.callbackId, 'test:none:none');
  assert.equal(ack.ok, true);
  assert.ok(ack.message);

  ws.close();
});

test('ghost callback — sends ack ok:true with ghost message for nonexistent task', async (t) => {
  const port = await findEphemeralPort();
  startClientManager(port);
  t.onTestFinished(() => stopClientManager());

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: authHeaders });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const ackPromise = new Promise<any>((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });

  ws.send(JSON.stringify({
    type: 'task-callback',
    device: 'test-device',
    callbackId: 'test:ghost:ffff',
    name: 'ghost-run',
    taskProject: 'nonexistent-project',
    taskId: 'ffff',
    termination: 'completed',
    exitCode: 0,
  }));

  const ack = await ackPromise;
  assert.equal(ack.type, 'task-callback-ack');
  assert.equal(ack.ok, true);
  assert.match(ack.message, /ghost/i);

  ws.close();
});

test('task already done — sends ack idempotent when task already done', async (t) => {
  const proj = nextProject();
  const taskId = 'a111';
  const { cleanup } = makeRepo(proj, BASE_TASK_YAML(taskId));
  t.onTestFinished(() => cleanup());

  // Mark the task done directly via lifecycle function
  const { completeTask } = await import('../src/domain/tasks/system/task-completion.js');
  completeTask(null, proj, 'already done', taskId);

  const port = await findEphemeralPort();
  startClientManager(port);
  t.onTestFinished(() => stopClientManager());

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: authHeaders });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const ackPromise = new Promise<any>((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });

  ws.send(JSON.stringify({
    type: 'task-callback',
    device: 'test-device',
    callbackId: 'test:done:idem',
    name: 'done-run',
    taskProject: proj,
    taskId,
    termination: 'completed',
    exitCode: 0,
  }));

  const ack = await ackPromise;
  assert.equal(ack.type, 'task-callback-ack');
  assert.equal(ack.ok, true);
  assert.match(ack.message, /idempotent/i);

  ws.close();
});

test('success path — completeTask with skipVerify=true, verify_warning contains remote-run', async (t) => {
  const proj = nextProject();
  const taskId = 'a222';
  const { tasksPath, cleanup } = makeRepo(proj, BASE_TASK_YAML(taskId));
  t.onTestFinished(() => cleanup());

  const port = await findEphemeralPort();
  startClientManager(port);
  t.onTestFinished(() => stopClientManager());

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: authHeaders });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const ackPromise = new Promise<any>((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });

  ws.send(JSON.stringify({
    type: 'task-callback',
    device: 'test-device',
    callbackId: 'test:success:222',
    name: 'success-run',
    taskProject: proj,
    taskId,
    termination: 'completed',
    exitCode: 0,
    durationHuman: '1.5h',
    remoteResultPath: '/remote/path/result.json',
    remoteLogPath: '/remote/path/output.log',
    logTail: 'done',
  }));

  const ack = await ackPromise;
  assert.equal(ack.type, 'task-callback-ack');
  assert.equal(ack.ok, true);

  // Verify TASKS.yaml state changed
  const parsed = yamlParse(fs.readFileSync(tasksPath, 'utf8'));
  const task = findTaskInYaml(parsed.tasks, taskId);
  assert.equal(task.status, 'done');
  assert.match(task['completed-note'], /cortex-run on test-device/);
  assert.match(task['completed-note'], /Remote: \/remote\/path\/result\.json/);
  // verify_warning should be in the result message from completeTask
  assert.match(ack.message, /verify skipped/i);

  ws.close();
});

test('failure path — blockTask with note containing termination and logTail', async (t) => {
  const proj = nextProject();
  const taskId = 'a333';
  const { tasksPath, cleanup } = makeRepo(proj, BASE_TASK_YAML(taskId));
  t.onTestFinished(() => cleanup());

  const port = await findEphemeralPort();
  startClientManager(port);
  t.onTestFinished(() => stopClientManager());

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: authHeaders });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const ackPromise = new Promise<any>((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });

  const logTail = 'Error: OOM\nTraceback ...\n';
  ws.send(JSON.stringify({
    type: 'task-callback',
    device: 'test-device',
    callbackId: 'test:failure:333',
    name: 'fail-run',
    taskProject: proj,
    taskId,
    termination: 'completed',
    exitCode: 1,
    durationHuman: '10m',
    remoteResultPath: '/remote/path/result.json',
    remoteLogPath: '/remote/path/output.log',
    logTail,
  }));

  const ack = await ackPromise;
  assert.equal(ack.type, 'task-callback-ack');
  assert.equal(ack.ok, true);

  // Read the TASKS.yaml to verify blocked state
  const parsed = yamlParse(fs.readFileSync(tasksPath, 'utf8'));
  const task = findTaskInYaml(parsed.tasks, taskId);
  assert.equal(task.status, 'open');
  assert.match(task['blocked-by'], /completed/);
  assert.match(task['blocked-by'], /log tail/);
  assert.match(task['blocked-by'], /remote.*result\.json/);
  assert.match(task['blocked-by'], /Error: OOM/);
  assert.doesNotMatch(task['blocked-by'], /idempotent/i);

  ws.close();
});

test('gpu capture — records the callback GPU onto the dispatch execution (DR-0018 §6.3)', async (t) => {
  const proj = nextProject();
  const taskId = 'a555';
  const { cleanup } = makeRepo(proj, BASE_TASK_YAML(taskId));
  t.onTestFinished(() => cleanup());

  // A dispatch execution keyed by taskId exists (registered at cortex-run launch).
  registerDispatchExecution({ taskId, machine: 'test-device', project: proj, runName: 'gpu-run' });
  assert.equal(getExecutionByTaskId(taskId)?.gpu, null);

  const port = await findEphemeralPort();
  startClientManager(port);
  t.onTestFinished(() => stopClientManager());

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: authHeaders });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const ackPromise = new Promise<any>((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });

  ws.send(JSON.stringify({
    type: 'task-callback',
    device: 'test-device',
    callbackId: 'test:gpu:555',
    name: 'gpu-run',
    taskProject: proj,
    taskId,
    termination: 'completed',
    exitCode: 0,
    gpu: { indices: [1], memoryMb: 49140 },
  }));

  await ackPromise;
  assert.deepEqual(getExecutionByTaskId(taskId)?.gpu, { indices: [1], memoryMb: 49140 });

  ws.close();
});

test('gpu capture — malformed gpu payload is ignored (record stays null)', async (t) => {
  const proj = nextProject();
  const taskId = 'a666';
  const { cleanup } = makeRepo(proj, BASE_TASK_YAML(taskId));
  t.onTestFinished(() => cleanup());

  registerDispatchExecution({ taskId, machine: 'test-device', project: proj, runName: 'bad-gpu-run' });

  const port = await findEphemeralPort();
  startClientManager(port);
  t.onTestFinished(() => stopClientManager());

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: authHeaders });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const ackPromise = new Promise<any>((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });

  ws.send(JSON.stringify({
    type: 'task-callback',
    device: 'test-device',
    callbackId: 'test:gpu:666',
    name: 'bad-gpu-run',
    taskProject: proj,
    taskId,
    termination: 'completed',
    exitCode: 0,
    gpu: { indices: 'not-an-array', memoryMb: 'x' },
  }));

  await ackPromise;
  assert.equal(getExecutionByTaskId(taskId)?.gpu, null);

  ws.close();
});

test('duplicate callback — first completes, second ack idempotent', async (t) => {
  const proj = nextProject();
  const taskId = 'a444';
  const { tasksPath, cleanup } = makeRepo(proj, BASE_TASK_YAML(taskId));
  t.onTestFinished(() => cleanup());

  const port = await findEphemeralPort();
  startClientManager(port);
  t.onTestFinished(() => stopClientManager());

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: authHeaders });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  // First callback — should complete the task
  const ack1Promise = new Promise<any>((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });

  ws.send(JSON.stringify({
    type: 'task-callback',
    device: 'test-device',
    callbackId: 'test:dup:444',
    name: 'dup-run',
    taskProject: proj,
    taskId,
    termination: 'completed',
    exitCode: 0,
  }));

  const ack1 = await ack1Promise;
  assert.equal(ack1.ok, true);

  // Second callback — should be idempotent
  const ack2Promise = new Promise<any>((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });

  ws.send(JSON.stringify({
    type: 'task-callback',
    device: 'test-device',
    callbackId: 'test:dup:444',
    name: 'dup-run',
    taskProject: proj,
    taskId,
    termination: 'completed',
    exitCode: 0,
  }));

  const ack2 = await ack2Promise;
  assert.equal(ack2.ok, true);
  assert.match(ack2.message, /idempotent|already done/i);

  // Verify task is done — should only be done once
  const parsed = yamlParse(fs.readFileSync(tasksPath, 'utf8'));
  const task = findTaskInYaml(parsed.tasks, taskId);
  assert.equal(task.status, 'done');

  ws.close();
});
