import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, onTestFinished, test, vi } from 'vitest';
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
import { _resetSubagentRuns, waitForSubagentRun, getSubagentChildStatuses, stopSubagentRun } from '../src/domain/agents/subagent/registry.js';
import { sessionHolds } from '../src/core/session-holds.js';
import { busyTracker } from '../src/orchestration/busy-tracker.js';
import type { EngineRun } from '../src/agent-adapter/types.js';
import type { SubagentToolDeps } from '../src/agent-adapter/pi/subagent.js';
import { handleSubagentWebhook } from '../src/orchestration/subagent-webhook.js';
import { runSubagent } from '../src/domain/agents/subagent/runner.js';
import { runRegistry } from '../src/core/run-registry.js';
import { profileRepo } from '../src/store/profile-repo.js';
import { handleSessionsTranscript, handleSessionsSubagentTranscript } from '../src/domain/ui-service/query/sessions.js';
import type { UiServiceDeps } from '../src/domain/ui-service/types.js';
import { transcriptHttp } from './subagent-transcript-http-fixture.js';

// Only child execution and final external delivery are fake. The webhook, daemon runner,
// native tool/bridge, notice parsers, registry, writer, store and UI query/service are real.
const execution = vi.hoisted(() => ({ create: vi.fn(), start: vi.fn() }));
vi.mock('../src/agent-adapter/pi/child-session.js', async original => ({
  ...await original<object>(), createChildSession: execution.create,
}));
vi.mock('../src/domain/runs/service.js', async original => ({
  ...await original<object>(), startRun: execution.start,
}));

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
  reject!: (error: Error) => void;
  prompts: string[] = [];
  requests: any[] = [];
  subscribe = (listener: (event: any) => void) => { this.listener = listener; return () => {}; };
  prompt = (text: string) => {
    this.prompts.push(text);
    return new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  };
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
  fs.writeFileSync(path.join(CONFIG_DIR, 'profiles.json'), JSON.stringify({
    defaultProfile: 'claude-fixture', defaultProfileByBackend: { claude: 'claude-fixture' },
    profiles: {
      'claude-fixture': { backend: 'claude', model: 'fixture-model', mode: 'api' },
      'pi-fixture': { backend: 'pi', model: 'fixture-model', mode: 'api', provider: 'fixture' },
    },
  }));
  profileRepo.invalidate();
  execution.create.mockReset(); execution.start.mockReset();
});

afterEach(async () => {
  await conversationHistory.flush();
  _resetSubagentRuns();
  sessionHolds.clear();
  setOrchestrationRuntime({ bus: null });
  process.send = originalSend;
  for (const run of runRegistry.getAll()) runRegistry.remove(run.registryKey);
  vi.unstubAllEnvs();
});

function installChild(child: Child) {
  execution.create.mockImplementation(async request => {
    child.requests.push(request);
    return { session: child, dispose() {} };
  });
  execution.start.mockImplementation((request, observers) => {
    child.requests.push(request);
    child.listener = event => {
      const normalized = childRunEvent(event);
      for (const observer of observers) observer.onEvent({ ...normalized, phase: 'foreground' });
    };
    const result = child.prompt(request.prompt.text).then(() => ({ finalOutput: 'child result', num_turns: 1 }));
    return { result, settled: result, cancel: () => child.resolve() };
  });
}

function childRunEvent(event: any) {
  if (event.type === 'tool_execution_start') return {
    type: 'tool_use', toolUseId: event.toolCallId, name: 'Bash', input: event.args,
  };
  if (event.type === 'tool_execution_end') return {
    type: 'tool_result', toolUseId: event.toolCallId, ok: true, content: event.result.content[0].text,
  };
  return { type: 'assistant_text', text: event.message.content[0].text };
}

function queryDeps(repo = conversationHistory): UiServiceDeps {
  return { conversationHistory: repo, bus, getSubagentChildStatuses } as unknown as UiServiceDeps;
}

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
  installChild(child);
  const adapter = new PIAdapter(async (request, callbacks) => {
    runtime = new FakeRuntime(request, callbacks);
    const deps: SubagentToolDeps = {
      agentDir: CONFIG_DIR, rolesDir, ensureRoles() {}, childExtensions: () => [],
      parentEnv: { CORTEX_SESSION_ID: SESSION, SLACK_CHANNEL: CHANNEL },
      createSession: execution.create,
      runForeignSubagent: runSubagent,
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

type Route = { entry: 'native' | 'webhook'; parentBackend: 'pi' | 'claude'; childBackend: 'pi' | 'claude' };
const routes: Route[] = [
  { entry: 'native', parentBackend: 'pi', childBackend: 'pi' },
  { entry: 'native', parentBackend: 'pi', childBackend: 'claude' },
  ...(['pi', 'claude'] as const).flatMap(parentBackend =>
    (['pi', 'claude'] as const).map(childBackend => ({ entry: 'webhook' as const, parentBackend, childBackend }))),
];
const task = { description: 'inspect', prompt: 'inspect', subagent_type: 'explore' };

async function spawn(fixture: Awaited<ReturnType<typeof parent>>, route: Route, params: object = task, ctx: any = { cwd: CONFIG_DIR }) {
  if (route.entry === 'webhook') {
    const reply = await handleSubagentWebhook({
      action: 'start', background: true, sessionId: SESSION, channel: CHANNEL,
      profile: `${route.parentBackend}-fixture`, cwd: CONFIG_DIR,
      params: { ...params, backend: route.childBackend },
    });
    assert.equal(reply.success, true, reply.error);
    const id = (reply.data as any).id;
    return { id, ref: `${id}#0` };
  }
  const result = await fixture.tool.execute('call-background', {
    ...params, backend: route.childBackend, run_in_background: true,
  }, undefined, () => {}, ctx);
  return { id: /Agent (\S+) started/.exec((result.content[0] as any).text)![1], ref: 'call-background#0' };
}

async function assertQueries(ref: string, toolCount: number, texts: string[]) {
  await conversationHistory.flush();
  const warm = await handleSessionsTranscript(queryDeps(), { sessionId: SESSION, compactSubagents: true });
  const detail = await handleSessionsSubagentTranscript(queryDeps(), { sessionId: SESSION, subagentId: ref });
  assert.equal(warm.subagentSummaries?.find(s => s.id === ref)?.toolCount, toolCount);
  assert.deepEqual(detail.messages.filter(m => m.type === 'assistant').map(m => m.text), texts);
  const cold = queryDeps(new ConversationHistoryRepo(HISTORY_DIR));
  const coldCompact = await handleSessionsTranscript(cold, { sessionId: SESSION, compactSubagents: true });
  assert.deepEqual(coldCompact.subagentSummaries, warm.subagentSummaries);
  assert.deepEqual(await handleSessionsSubagentTranscript(cold, { sessionId: SESSION, subagentId: ref }), detail);
  return { warm, detail };
}

function registerUnrelatedRun() {
  const ingest = vi.fn(() => true);
  runRegistry.register({
    executionId: 'unrelated', threadId: null, channel: CHANNEL, agentSlotId: null,
    kind: 'local', kill: () => true, backend: 'pi', trackSessionId: 'other-session',
    run: { phase: 'foreground', ingestExternal: ingest } as any,
  });
  return ingest;
}

test.each(routes)('$entry $parentBackend → $childBackend: late CONTENT survives drain, next turn and parent disposal', async (route) => {
  const child = new Child();
  const fixture = await parent(child);
  onTestFinished(() => fixture.engine.close());
  const active = await turn(fixture);
  const ingest = registerUnrelatedRun();
  const started = await spawn(fixture, route);
  await vi.waitFor(() => assert.ok(child.resolve));
  child.tool('early'); child.text('early prose');
  await finishParent(fixture, active);
  child.tool('late'); child.text('late prose');
  await assertQueries(started.ref, 2, ['early prose', 'late prose']);
  const next = await turn(fixture);
  child.tool('next'); child.text('next prose');
  await finishParent(fixture, next);
  await fixture.engine.close();
  assert.equal(fixture.runtime.disposed, true);
  child.tool('disposed'); child.text('final prose'); child.resolve();
  await waitForSubagentRun(started.id, 1000);
  const { warm } = await assertQueries(started.ref, 4, ['early prose', 'late prose', 'next prose', 'final prose']);
  assert.equal(warm.subagentSummaries?.[0].status, 'completed');
  assert.equal(messages.length, 9, 'four tools, four prose rows, one end: no duplicate writer');
  assert.ok(messages.every(e => e.subagentId === started.ref && e.sessionId === SESSION));
  assert.equal(messages.filter(e => e.subagentEnded === 'completed').length, 1);
  assert.equal(ingest.mock.calls.length, 0, 'never look up a same-channel run, even at spawn');
  assert.ok([...active.events, ...next.events].every(e => !e.subagent && e.type !== 'subagent_end'));
  const debug = await conversationHistory.getToolDebugDetails(SESSION, `${started.ref}:disposed`);
  assert.equal(debug?.toolResult?.content, 'disposed result');
});

test('actual HTTP/SSE: expanded transcript continues after Pi foreground closes, with exactly-once events', async () => {
  const child = new Child();
  const fixture = await parent(child);
  const http = await transcriptHttp(queryDeps(), SESSION);
  onTestFinished(async () => { await fixture.engine.close(); await http.close(); });
  const active = await turn(fixture);
  const started = await spawn(fixture, routes[0]);
  await vi.waitFor(() => assert.ok(child.resolve));
  child.tool('early'); child.text('early prose');
  await conversationHistory.flush();
  const input = { sessionId: SESSION, subagentId: started.ref };
  assert.equal((await http.query('sessions.subagentTranscript', input)).messages.length, 2);
  await finishParent(fixture, active);
  child.tool('late'); child.text('late prose'); child.resolve();
  await waitForSubagentRun(started.id, 1000);
  await conversationHistory.flush();
  await vi.waitFor(() => assert.equal(http.stream.events.length, 9, http.stream.wire));
  const events = http.stream.events;
  assert.equal(events.filter(e => e.type === 'session.message').length, 5);
  assert.equal(events.filter(e => e.type === 'session.debug.updated').length, 4);
  const compact = await http.query('sessions.transcript', { sessionId: SESSION, compactSubagents: true });
  assert.equal(compact.subagentSummaries[0].toolCount, 2);
  assert.equal(compact.subagentSummaries[0].status, 'completed');
  const detail = await http.query('sessions.subagentTranscript', input);
  assert.deepEqual(detail.messages.filter((m: any) => m.type === 'assistant').map((m: any) => m.text), ['early prose', 'late prose']);
  const debug = await http.query('sessions.debugDetails', { sessionId: SESSION, ref: `${started.ref}:late` });
  assert.equal(debug.toolResult.content, 'late result');
});
