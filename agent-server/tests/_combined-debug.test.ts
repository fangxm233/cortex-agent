import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import type { PIAgentProcess } from '../src/agent-adapter/pi/adapter.js';
import { encodeCommand } from '../src/agent-adapter/pi/framing.js';

const SESSION_DIR = pathJoin(tmpdir(), `pi-shims-debug2-${process.pid}`);
mkdirSync(SESSION_DIR, { recursive: true });

interface StubChild extends EventEmitter {
  stdin: PassThrough & { writeHistory: string[] };
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  __killed: boolean;
}

function makeStubChild(): StubChild {
  const emitter = new EventEmitter() as StubChild;
  const stdin = new PassThrough() as PassThrough & { writeHistory: string[] };
  stdin.writeHistory = [];
  const origWrite = stdin.write.bind(stdin);
  (stdin as any).write = (chunk: unknown, ...rest: unknown[]) => {
    const s = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
    stdin.writeHistory.push(s);
    return origWrite(chunk as any, ...(rest as any));
  };
  emitter.stdin = stdin;
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.__killed = false;
  emitter.kill = () => { emitter.__killed = true; return true; };
  return emitter;
}

function makeStubSpawner() {
  const children: StubChild[] = [];
  return {
    children,
    spawn: (_cmd: string, _args: string[], _opts: SpawnOptions) => {
      const child = makeStubChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
  };
}

function pushLine(child: StubChild, obj: unknown): void {
  child.stdout.write(JSON.stringify(obj) + '\n');
}

async function bootstrap(child: StubChild, sessionId = 'sess-abc'): Promise<void> {
  pushLine(child, {
    type: 'response', id: 'bootstrap', command: 'get_state', success: true,
    data: { sessionId },
  });
  await Promise.resolve();
}

// Test 1 (same as original)
test('test1: send resolves with AgentResult', async () => {
  console.log('[T1] start');
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k1', sessionId: null, resume: false });
  const child = s.children[0];
  await bootstrap(child);
  const turnPromise = proc.send({ text: 'hello' });
  pushLine(child, {
    type: 'agent_end',
    messages: [{ role: 'assistant', content: 'ok', usage: { cost: { total: 0.005 } } }],
  });
  await Promise.resolve();
  const result = await turnPromise;
  assert.equal(result.sessionId, 'sess-abc');
  child.emit('close', 0);
  await proc.close();
  console.log('[T1] done, active handles:', (process as any)._getActiveHandles?.().length ?? '?');
  console.log('[T1] active requests:', (process as any)._getActiveRequests?.().length ?? '?');
});

// Test 5 (plan flow, same as original)
test('test5: plan flow', async () => {
  console.log('[T5] start');
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k5', sessionId: null, resume: false }) as PIAgentProcess;
  const child = s.children[0];
  await bootstrap(child);
  const turnPromise = proc.send({ text: 'build a feature' });
  const PLAN_PATH = '/repo/.claude/plans/plan.md';
  pushLine(child, {
    type: 'tool_execution_start', toolCallId: 'tc-write', toolName: 'write',
    args: { file_path: PLAN_PATH, content: 'Plan: do X' },
  });
  pushLine(child, {
    type: 'tool_execution_end', toolCallId: 'tc-write',
    result: { content: [{ type: 'text', text: 'Written.' }] },
  });
  await Promise.resolve();

  pushLine(child, {
    type: 'tool_execution_start', toolCallId: 'tc-epm', toolName: 'exit_plan_mode',
    args: { plan: 'Plan: do X' },
  });
  await Promise.resolve();

  const collectedEvents: string[] = [];
  console.log('[T5] starting collectLoop');
  const collectLoop = (async () => {
    let count = 0;
    for await (const evt of proc.events) {
      count++;
      console.log(`[T5] event #${count}: ${evt.type}`);
      collectedEvents.push(evt.type);
      if (evt.type === 'turn_complete') break;
      if (count > 50) { console.log('[T5] SAFETY BREAK at 50'); break; }
    }
    console.log('[T5] collectLoop done');
  })();

  pushLine(child, {
    type: 'extension_ui_request', id: 'ui-confirm-1', method: 'confirm',
    title: 'Plan ready for review',
  });
  await Promise.resolve();

  proc.sendExtensionUiResponse('ui-confirm-1', { confirmed: true });

  pushLine(child, {
    type: 'tool_execution_end', toolCallId: 'tc-epm',
    result: { content: [{ type: 'text', text: 'Approved.' }] },
  });
  pushLine(child, {
    type: 'agent_end',
    messages: [{ role: 'assistant', content: 'done', usage: { cost: { total: 0.01 } } }],
  });
  await Promise.resolve();
  await Promise.resolve();

  console.log('[T5] awaiting turnPromise...');
  const result = await turnPromise;
  console.log('[T5] turnPromise resolved');
  console.log('[T5] awaiting collectLoop...');
  await collectLoop;
  console.log('[T5] all done');

  child.emit('close', 0);
  await proc.close();
  console.log('[T5] cleanup done, active handles:', (process as any)._getActiveHandles?.().length ?? '?');
});
