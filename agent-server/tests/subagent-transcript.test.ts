import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { CONFIG_DIR, HISTORY_DIR } from '../src/core/paths.js';
import { EventBus } from '../src/events/event-bus.js';
import { conversationHistory, ConversationHistoryRepo } from '../src/store/conversation-history-repo.js';
import { setOrchestrationRuntime } from '../src/orchestration/runtime.js';
import { createTranscriptSink } from '../src/orchestration/transcript-sink.js';
import { startBackgroundSubagent } from '../src/orchestration/pi-background-subagent.js';
import { createSubagentTool } from '../src/agent-adapter/pi/subagent.js';
import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import { FakeRuntime } from './agent-adapter/pi-fake-runtime.js';
import { piPool } from './agent-adapter/pi-pool-fixture.js';
import { engineSpecFixture } from './engine-spec-fixture.js';
import { _resetSubagentRuns, waitForSubagentRun } from '../src/domain/agents/subagent/registry.js';
import { sessionHolds } from '../src/core/session-holds.js';
import { busyTracker } from '../src/orchestration/busy-tracker.js';
import type { EngineRun } from '../src/agent-adapter/types.js';
import type { SubagentToolDeps } from '../src/agent-adapter/pi/subagent.js';

vi.mock('../src/orchestration/session-gateway.js', () => ({ deliverToSessionDetached: vi.fn() }));
const SESSION = 'background-transcript-fixture';
const CHANNEL = 'web:background-transcript-fixture';
const rolesDir = path.join(CONFIG_DIR, 'agents');
let originalSend: typeof process.send;
let bus: EventBus;
let messages: any[];

class Child {
  listener: (event: any) => void = () => {};
  resolve!: () => void;
  subscribe = (listener: (event: any) => void) => { this.listener = listener; return () => {}; };
  prompt = () => new Promise<void>(resolve => { this.resolve = resolve; });
  abort = async () => this.resolve();
  text(text: string) {
    this.listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  }
  tool(id: string) {
    this.listener({ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command: id } });
    this.listener({ type: 'tool_execution_end', toolCallId: id, result: { content: [{ type: 'text', text: `${id} result` }] } });
  }
}

beforeEach(async () => {
  originalSend = process.send;
  process.send = undefined;
  vi.stubEnv('DEBUG', '1');
  _resetSubagentRuns();
  bus = new EventBus();
  messages = [];
  bus.subscribe('session.message', event => { messages.push(event); });
  setOrchestrationRuntime({ bus });
  busyTracker.setBus(bus);
  fs.mkdirSync(rolesDir, { recursive: true });
  fs.writeFileSync(path.join(rolesDir, 'explore.md'), '---\nname: explore\ndescription: fixture\n---\nExplore');
  await conversationHistory.clear(SESSION);
  await conversationHistory.appendUser(SESSION, { text: 'delegate' });
});

afterEach(async () => {
  await conversationHistory.flush();
  _resetSubagentRuns();
  sessionHolds.clear();
  setOrchestrationRuntime({ bus: null });
  process.send = originalSend;
  vi.unstubAllEnvs();
});

function drain(run: EngineRun) {
  const events: any[] = [];
  const sink = createTranscriptSink({ sessionId: SESSION, channel: CHANNEL, sessionName: '', debug: true });
  const done = (async () => {
    for await (const event of run.events) { events.push(event); await sink.onEvent(event); }
  })();
  return { events, done };
}

async function parent(child: Child) {
  let runtime!: FakeRuntime;
  let tool!: ReturnType<typeof createSubagentTool>;
  const adapter = new PIAdapter(async (request, callbacks) => {
    runtime = new FakeRuntime(request, callbacks);
    const deps: SubagentToolDeps = {
      agentDir: CONFIG_DIR, rolesDir, ensureRoles() {}, childExtensions: () => [],
      parentEnv: { CORTEX_SESSION_ID: SESSION, SLACK_CHANNEL: CHANNEL },
      createSession: async () => ({ session: child as any, dispose() {} }),
      startBackgroundSubagent,
      onEvent: notice => callbacks.onEvent({ type: 'cortex_subagent_event', notice }),
    };
    tool = createSubagentTool(deps);
    return runtime;
  });
  const engine = piPool(adapter).open(engineSpecFixture({ sessionId: null, sessionKey: SESSION, resume: false }));
  await vi.waitFor(() => assert.ok(runtime));
  return { engine, runtime, tool };
}

async function turn(fixture: Awaited<ReturnType<typeof parent>>) {
  const prompted = fixture.runtime.nextCall('prompt');
  const run = fixture.engine.run({ text: 'go' }, { awaitBackground: 'none' });
  const collected = drain(run);
  await prompted;
  fixture.runtime.emitAgentStart();
  return { run, ...collected };
}

async function finishParent(fixture: Awaited<ReturnType<typeof parent>>, active: Awaited<ReturnType<typeof turn>>) {
  fixture.runtime.emitAgentEnd();
  await active.run.result;
  await active.done; // Real PISession.turnStream and PIEngine queue have both closed.
}

test('native background child persists late tool/result/prose/end after actual parent stream drains', async (t) => {
  const child = new Child();
  const fixture = await parent(child);
  t.onTestFinished(() => fixture.engine.close());
  const active = await turn(fixture);
  const result = await fixture.tool.execute('call-background', {
    description: 'inspect', prompt: 'inspect', subagent_type: 'explore', run_in_background: true,
  }, undefined, () => {}, { cwd: CONFIG_DIR } as any);
  const runId = /Agent (\S+) started/.exec((result.content[0] as any).text)![1];
  await vi.waitFor(() => assert.ok(child.resolve));
  child.tool('early'); child.text('early prose');
  await finishParent(fixture, active);
  child.tool('late'); child.text('late prose');
  child.resolve();
  await waitForSubagentRun(runId, 1000);
  await conversationHistory.flush();
  const history = await conversationHistory.getHistory(SESSION);
  assert.match(JSON.stringify(history), /late prose/, 'late CONTENT must survive parent completion');
  assert.match(JSON.stringify(history), /late result/);
  assert.equal(messages.filter(e => e.text === 'late prose').length, 1);
  assert.equal(messages.filter(e => e.subagentEnded === 'completed').length, 1);
  assert.deepEqual(await new ConversationHistoryRepo(HISTORY_DIR).getHistory(SESSION), history);
});
