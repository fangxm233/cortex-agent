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

const SESSION_DIR = pathJoin(tmpdir(), `pi-shims-debug-${process.pid}`);
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

test('plan flow debug', async () => {
  console.log('[D] test start');
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k5', sessionId: null, resume: false }) as PIAgentProcess;
  const child = s.children[0];

  await bootstrap(child);
  console.log('[D] bootstrapped, sessionId=', (proc as any).sessionId);

  const turnPromise = proc.send({ text: 'build a feature' });
  console.log('[D] send() called');

  const PLAN_PATH = '/repo/.claude/plans/plan.md';
  pushLine(child, {
    type: 'tool_execution_start', toolCallId: 'tc-write', toolName: 'write',
    args: { file_path: PLAN_PATH, content: 'Plan: do X' },
  });
  console.log('[D] pushed tool_execution_start (write)');
  pushLine(child, {
    type: 'tool_execution_end', toolCallId: 'tc-write',
    result: { content: [{ type: 'text', text: 'Written.' }] },
  });
  console.log('[D] pushed tool_execution_end (write)');
  await Promise.resolve();

  pushLine(child, {
    type: 'tool_execution_start', toolCallId: 'tc-epm', toolName: 'exit_plan_mode',
    args: { plan: 'Plan: do X' },
  });
  console.log('[D] pushed tool_execution_start (exit_plan_mode)');
  await Promise.resolve();

  const collectedEvents: string[] = [];
  console.log('[D] starting collectLoop');
  const collectLoop = (async () => {
    let count = 0;
    for await (const evt of proc.events) {
      count++;
      console.log(`[D] collectLoop got event #${count}: ${evt.type}`);
      collectedEvents.push(evt.type);
      if (evt.type === 'turn_complete') break;
      if (count > 50) { console.log('[D] SAFETY BREAK'); break; }
    }
    console.log('[D] collectLoop done');
  })();

  console.log('[D] pushing extension_ui_request');
  pushLine(child, {
    type: 'extension_ui_request', id: 'ui-confirm-1', method: 'confirm',
    title: 'Plan ready for review',
  });
  await Promise.resolve();
  console.log('[D] pushed extension_ui_request, sending approval');

  proc.sendExtensionUiResponse('ui-confirm-1', { confirmed: true });

  console.log('[D] pushing tool_execution_end + agent_end');
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
  console.log('[D] awaiting turnPromise...');

  const result = await turnPromise;
  console.log('[D] turnPromise resolved, planFilePath=', result.planFilePath);
  console.log('[D] awaiting collectLoop...');
  await collectLoop;
  console.log('[D] all done, collectedEvents=', collectedEvents);

  child.emit('close', 0);
  await proc.close();
});
