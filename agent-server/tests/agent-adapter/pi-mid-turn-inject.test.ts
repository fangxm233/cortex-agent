// input:  PIAdapter + stub PI RPC child emitting real message_start/agent_end/response lines
// output: PI prompt-steering framing, delivery ack, idle-boundary, rejection, and exit guarantees
// pos:    PI backend mid-turn injection wiring regression (hermetic, no provider)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import type { AgentProcess } from '../../src/agent-adapter/types.js';
import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';

interface StubChild extends EventEmitter {
  stdin: PassThrough & { writeHistory: string[]; failWrites: boolean };
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  closed: boolean;
}

function makeStubChild(): StubChild {
  const child = new EventEmitter() as StubChild;
  const stdin = new PassThrough() as StubChild['stdin'];
  stdin.writeHistory = [];
  stdin.failWrites = false;
  const write = stdin.write.bind(stdin);
  (stdin as any).write = (chunk: unknown, ...rest: unknown[]) => {
    if (stdin.failWrites) throw new Error('EPIPE');
    const text = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
    stdin.writeHistory.push(text);
    return write(chunk as any, ...(rest as any));
  };
  child.stdin = stdin;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.closed = false;
  child.kill = () => true;
  return child;
}

function spawnProcess(): { proc: AgentProcess; child: StubChild } {
  let child: StubChild | null = null;
  const spawn = (_cmd: string, _args: string[], _opts: SpawnOptions): ChildProcess => {
    child = makeStubChild();
    return child as unknown as ChildProcess;
  };
  const proc = new PIAdapter(spawn).spawn({
    sessionId: null,
    sessionKey: `pi-inject-${Math.random()}`,
    resume: false,
  });
  return { proc, child: child! };
}

function pushLine(child: StubChild, event: unknown): void {
  child.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`));
}

function closeChild(child: StubChild, code = 0): void {
  if (child.closed) return;
  child.closed = true;
  child.emit('close', code, null);
}

function userStart(text: string): unknown {
  return { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } };
}

function agentEnd(cost: number): unknown {
  return {
    type: 'agent_end',
    messages: [{ role: 'assistant', content: [], usage: { cost: { total: cost } } }],
  };
}

function steeringWrites(child: StubChild): Array<Record<string, unknown>> {
  return child.stdin.writeHistory
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((command) => typeof command['id'] === 'string' && command['type'] === 'prompt');
}

async function cleanup(proc: AgentProcess, child: StubChild): Promise<void> {
  closeChild(child);
  await proc.close();
}

async function nextEvent(proc: AgentProcess): Promise<NormalizedEvent | undefined> {
  const result = await proc.events[Symbol.asyncIterator]().next();
  return result.done ? undefined : result.value;
}

test('injectUserMessage refuses an idle PI process without writing a prompt', async (t) => {
  const { proc, child } = spawnProcess();
  t.onTestFinished(() => cleanup(proc, child));
  const before = child.stdin.writeHistory.length;

  assert.equal(proc.injectUserMessage?.({ text: 'steer me' }), false);
  assert.equal(child.stdin.writeHistory.length, before);
});

test('injection refuses while sendTurn is still switching to the target session', async (t) => {
  const children: StubChild[] = [];
  const spawn = (_cmd: string, _args: string[], _opts: SpawnOptions): ChildProcess => {
    const child = makeStubChild();
    children.push(child);
    return child as unknown as ChildProcess;
  };
  const adapter = new PIAdapter(spawn);
  const first = adapter.spawn({ sessionId: null, sessionKey: 'pi-switch-first', resume: false });
  const second = adapter.spawn({ sessionId: null, sessionKey: 'pi-switch-second', resume: false });
  const [firstChild, secondChild] = children;
  t.onTestFinished(async () => {
    await cleanup(first, firstChild!);
    await cleanup(second, secondChild!);
  });
  pushLine(firstChild!, {
    type: 'response', id: 'bootstrap', command: 'get_state', success: true,
    data: { sessionId: 'session-a', sessionFile: '/tmp/session-a.jsonl' },
  });
  pushLine(secondChild!, {
    type: 'response', id: 'bootstrap', command: 'get_state', success: true,
    data: { sessionId: 'session-b', sessionFile: '/tmp/session-b.jsonl' },
  });

  const divert = adapter.switchSession('session-b', 'pi-switch-first');
  const divertCommand = JSON.parse(firstChild!.stdin.writeHistory.at(-1)!) as Record<string, unknown>;
  pushLine(firstChild!, {
    type: 'response', id: divertCommand['id'], command: 'switch_session', success: true, data: { cancelled: false },
  });
  await divert;

  const turn = first.send({ text: 'opening after switch-back' });
  assert.equal(first.injectUserMessage?.({ text: 'too early' }), false);
  const switchBack = JSON.parse(firstChild!.stdin.writeHistory.at(-1)!) as Record<string, unknown>;
  assert.equal(switchBack['type'], 'switch_session');
  pushLine(firstChild!, {
    type: 'response', id: switchBack['id'], command: 'switch_session', success: true, data: { cancelled: false },
  });
  await Promise.resolve();
  assert.equal(first.injectUserMessage?.({ text: 'now safe' }), true);

  pushLine(firstChild!, userStart('opening after switch-back'));
  pushLine(firstChild!, userStart('now safe'));
  pushLine(firstChild!, agentEnd(0.01));
  await turn;
});

test('active PI turn writes attachment-aware prompt RPC with streamingBehavior=steer', async (t) => {
  const { proc, child } = spawnProcess();
  t.onTestFinished(() => cleanup(proc, child));
  const turn = proc.send({ text: 'opening' });

  assert.equal(proc.injectUserMessage?.({
    text: 'inspect this',
    attachments: [{ mimeType: 'image/png', path: '/tmp/frame.png' }],
  }), true);

  const [command] = steeringWrites(child);
  assert.ok(command, 'one id-correlated steering prompt is written');
  assert.equal(command['streamingBehavior'], 'steer');
  assert.match(String(command['message']), /inspect this/);
  assert.match(String(command['message']), /\/tmp\/frame\.png/);

  pushLine(child, userStart('opening'));
  pushLine(child, userStart('inspect this'));
  pushLine(child, agentEnd(0.01));
  await turn;
});

test('opening user event is ignored, then steering messages ack FIFO including duplicate text', async (t) => {
  const { proc, child } = spawnProcess();
  t.onTestFinished(() => cleanup(proc, child));
  const delivered: Array<{ text: string; foldedIntoTurn: boolean }> = [];
  proc.setInjectionAckSink?.({ onDelivered: (message) => delivered.push(message) });
  const turn = proc.send({ text: 'opening' });

  proc.injectUserMessage?.({ text: 'same' });
  proc.injectUserMessage?.({ text: 'same' });
  pushLine(child, userStart('opening'));
  assert.deepEqual(delivered, [], 'the external turn opening prompt is not a steering ack');

  pushLine(child, userStart('transformed-by-pi'));
  pushLine(child, userStart('transformed-by-pi'));
  assert.deepEqual(delivered, [
    { text: 'same', foldedIntoTurn: true },
    { text: 'same', foldedIntoTurn: true },
  ]);

  pushLine(child, agentEnd(0.01));
  await turn;
});

test('a later rejected duplicate waits for the earlier duplicate delivery before sealing FIFO', async (t) => {
  const { proc, child } = spawnProcess();
  t.onTestFinished(() => cleanup(proc, child));
  const lifecycle: string[] = [];
  proc.setInjectionAckSink?.({
    onDelivered: ({ text }) => lifecycle.push(`delivered:${text}`),
    onUndelivered: ({ text }) => lifecycle.push(`undelivered:${text}`),
  });
  const turn = proc.send({ text: 'opening' });

  proc.injectUserMessage?.({ text: 'same' });
  proc.injectUserMessage?.({ text: 'same' });
  const commands = steeringWrites(child);
  pushLine(child, userStart('opening'));
  pushLine(child, {
    type: 'response', id: commands[1]!['id'], command: 'prompt', success: false, error: 'second rejected',
  });
  assert.deepEqual(lifecycle, [], 'second duplicate cannot seal ahead of the first');

  pushLine(child, userStart('same'));
  assert.deepEqual(lifecycle, ['delivered:same', 'undelivered:same']);
  pushLine(child, agentEnd(0.01));
  await turn;
});

test('idle-boundary first agent_end is suppressed and final result aggregates both PI runs', async (t) => {
  const { proc, child } = spawnProcess();
  t.onTestFinished(() => cleanup(proc, child));
  const delivered: string[] = [];
  proc.setInjectionAckSink?.({ onDelivered: ({ text }) => delivered.push(text) });
  const turn = proc.send({ text: 'opening' });
  let settled = false;
  void turn.finally(() => { settled = true; });

  pushLine(child, userStart('opening'));
  proc.injectUserMessage?.({ text: 'late steering' });
  pushLine(child, agentEnd(0.02));
  await Promise.resolve();
  assert.equal(settled, false, 'the old run cannot terminate Cortex while its race-safe prompt is pending');

  pushLine(child, userStart('late steering'));
  pushLine(child, agentEnd(0.03));
  const result = await turn;
  assert.deepEqual(delivered, ['late steering']);
  assert.equal(result.num_turns, 2);
  assert.equal(result.total_cost_usd, 0.05);

  const terminal = await nextEvent(proc);
  assert.equal(terminal?.type, 'turn_complete');
  if (terminal?.type === 'turn_complete') {
    assert.equal(terminal.numTurns, 2);
    assert.equal(terminal.totalCostUsd, 0.05);
  }
});

test('failed steering RPC after a deferred completion seals the message and settles the original turn', async (t) => {
  const { proc, child } = spawnProcess();
  t.onTestFinished(() => cleanup(proc, child));
  const undelivered: string[] = [];
  proc.setInjectionAckSink?.({
    onDelivered: () => assert.fail('rejected steering must not be delivered'),
    onUndelivered: ({ text }) => undelivered.push(text),
  });
  const turn = proc.send({ text: 'opening' });

  pushLine(child, userStart('opening'));
  proc.injectUserMessage?.({ text: 'rejected steering' });
  const [command] = steeringWrites(child);
  pushLine(child, agentEnd(0.02));
  pushLine(child, {
    type: 'response', id: command!['id'], command: 'prompt', success: false, error: 'prompt rejected',
  });

  const result = await turn;
  assert.deepEqual(undelivered, ['rejected steering']);
  assert.equal(result.num_turns, 1);
  assert.equal(result.total_cost_usd, 0.02);

  assert.equal((await nextEvent(proc))?.type, 'error', 'PI rejection remains observable');
  assert.equal((await nextEvent(proc))?.type, 'turn_complete', 'deferred terminal event is restored');
});

test('stdin write failure refuses injection and removes its local pending entry', async (t) => {
  const { proc, child } = spawnProcess();
  t.onTestFinished(() => cleanup(proc, child));
  const turn = proc.send({ text: 'opening' });
  child.stdin.failWrites = true;

  assert.equal(proc.injectUserMessage?.({ text: 'cannot write' }), false);
  child.stdin.failWrites = false;
  pushLine(child, userStart('opening'));
  pushLine(child, agentEnd(0.01));
  await turn;
});

test('process exit reports every queued steering message as undelivered', async (t) => {
  const { proc, child } = spawnProcess();
  t.onTestFinished(() => proc.close());
  const undelivered: string[] = [];
  proc.setInjectionAckSink?.({
    onDelivered: () => assert.fail('exited process cannot deliver'),
    onUndelivered: ({ text }) => undelivered.push(text),
  });
  const turn = proc.send({ text: 'opening' });

  proc.injectUserMessage?.({ text: 'one' });
  proc.injectUserMessage?.({ text: 'two' });
  child.stderr.emit('data', Buffer.from('backend exited'));
  closeChild(child, 1);

  await assert.rejects(turn, /backend exited/);
  assert.deepEqual(undelivered, ['one', 'two']);
});
