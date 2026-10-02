import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, onTestFinished, test, vi } from 'vitest';
import { CONFIG_DIR, STORE_DIR } from '../src/core/paths.js';
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
// _vitest-setup gives this file its own temporary CORTEX_HOME; no private sessions are read.
const HISTORY_DIR = path.join(STORE_DIR, 'conversation-history');
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

function installChild(...children: Child[]) {
  const pending = [...children];
  execution.create.mockImplementation(async request => {
    const child = pending.shift()!;
    child.requests.push(request);
    return { session: child, dispose() {} };
  });
  execution.start.mockImplementation((request, observers) => fakeChildRun(pending.shift()!, request, observers));
}

function fakeChildRun(child: Child, request: any, observers: any[]) {
  child.requests.push(request);
  child.listener = event => {
    const normalized = childRunEvent(event);
    for (const observer of observers) observer.onEvent({ ...normalized, phase: 'foreground' });
  };
  const result = child.prompt(request.prompt.text).then(() => ({ finalOutput: 'child result', num_turns: 1 }));
  return { result, settled: result, cancel: () => child.resolve() };
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
  assert.deepEqual(events.filter(e => e.type === 'session.message').map(e => e.payload), messages);
  assert.equal(events.filter(e => e.type === 'session.debug.updated').length, 4);
  const compact = await http.query('sessions.transcript', { sessionId: SESSION, compactSubagents: true });
  assert.equal(compact.subagentSummaries[0].toolCount, 2);
  assert.equal(compact.subagentSummaries[0].status, 'completed');
  const detail = await http.query('sessions.subagentTranscript', input);
  assert.deepEqual(detail.messages.filter((m: any) => m.type === 'assistant').map((m: any) => m.text), ['early prose', 'late prose']);
  const debug = await http.query('sessions.debugDetails', { sessionId: SESSION, ref: `${started.ref}:late` });
  assert.equal(debug.toolResult.content, 'late result');
});

const endings = routes.flatMap(route => (['startup', 'error', 'abort'] as const).map(ending => ({ ...route, ending })));

test.each(endings)('$entry $parentBackend → $childBackend: $ending seals only the started child once', async route => {
  const child = new Child();
  const fixture = await parent(child);
  onTestFinished(() => fixture.engine.close());
  if (route.ending === 'startup') {
    execution.create.mockRejectedValue(new Error('startup refused'));
    execution.start.mockImplementation(() => { throw new Error('startup refused'); });
  }
  const active = await turn(fixture);
  const started = await spawn(fixture, route);
  await finishParent(fixture, active);
  if (route.ending !== 'startup') {
    await vi.waitFor(() => assert.ok(child.resolve));
    child.tool('before-failure'); child.text('before failure');
    if (route.ending === 'abort') stopSubagentRun(started.id);
    else child.reject(new Error('execution failed'));
  }
  await waitForSubagentRun(started.id, 1000);
  await conversationHistory.flush();
  const status = route.ending === 'abort' ? 'killed' : 'failed';
  assert.deepEqual([...getSubagentChildStatuses(SESSION)], [[started.ref, status]]);
  assert.deepEqual(messages.filter(e => e.subagentEnded).map(e => [e.subagentId, e.subagentEnded]), [[started.ref, status]]);
  const history = await new ConversationHistoryRepo(HISTORY_DIR).getHistory(SESSION);
  assert.equal(history?.subagentEnds?.length, 1);
  assert.equal(history?.subagentEnds?.[0].status, status);
});

function batchTasks(route: Route) {
  return [task, { ...task, description: 'second', prompt: 'follow {previous}' }]
    .map(item => ({ ...item, backend: route.childBackend }));
}

async function batchFixture(route: Route, mode: 'parallel' | 'chain', ctx?: any) {
  const first = new Child(); const second = new Child();
  const fixture = await parent(first);
  onTestFinished(() => fixture.engine.close());
  installChild(first, second);
  const active = await turn(fixture);
  const started = await spawn(fixture, route, { [mode]: batchTasks(route) }, ctx);
  await vi.waitFor(() => assert.ok(first.resolve));
  await finishParent(fixture, active);
  return { fixture, first, second, started, ref2: started.ref.replace(/#0$/, '#1') };
}

test.each(routes)('$entry $parentBackend → $childBackend: parallel sibling status/content are independent', async route => {
  const { first, second, started, ref2 } = await batchFixture(route, 'parallel');
  await vi.waitFor(() => assert.ok(second.resolve));
  second.tool('sibling'); second.text('sibling finished'); second.resolve();
  await vi.waitFor(() => assert.equal(getSubagentChildStatuses(SESSION).get(ref2), 'completed'));
  assert.equal(getSubagentChildStatuses(SESSION).get(started.ref), 'running');
  await conversationHistory.appendUser(SESSION, { text: 'another user turn' });
  first.tool('still-running'); first.text('first still working');
  const { warm } = await assertQueries(started.ref, 1, ['first still working']);
  assert.equal(warm.subagentSummaries?.find(s => s.id === started.ref)?.status, 'running');
  first.resolve();
  await waitForSubagentRun(started.id, 1000);
  await assertQueries(ref2, 1, ['sibling finished']);
  assert.deepEqual(messages.filter(e => e.subagentEnded).map(e => e.subagentId), [ref2, started.ref]);
});

test.each(routes)('$entry $parentBackend → $childBackend: chain starts after drain with substituted prompt and snapshotted context', async route => {
  let contextAlive = true;
  const ctx = {
    get cwd() { assert.ok(contextAlive, 'do not retain parent SDK context'); return CONFIG_DIR; },
    get model() { assert.ok(contextAlive, 'do not retain parent SDK context'); return { id: 'original-model', provider: 'fixture' }; },
  };
  const { fixture, first, second, started, ref2 } = await batchFixture(route, 'chain', ctx);
  contextAlive = false;
  await fixture.engine.close();
  assert.equal(getSubagentChildStatuses(SESSION).has(ref2), false, 'unstarted link is not running');
  first.text('child result'); first.resolve();
  await vi.waitFor(() => assert.ok(second.resolve));
  assert.match(second.prompts[0], /follow child result/);
  assert.equal(second.requests[0].cwd, CONFIG_DIR);
  if (route.entry === 'native' && route.childBackend === 'pi') assert.equal(second.requests[0].model, 'original-model');
  second.tool('chain-late'); second.text('chain finished'); second.resolve();
  await waitForSubagentRun(started.id, 1000);
  await assertQueries(ref2, 1, ['chain finished']);
  const history = await conversationHistory.getHistory(SESSION);
  assert.match(JSON.stringify(history), /follow child result/, 'persist the substituted runtime prompt');
  assert.deepEqual(messages.filter(e => e.subagentEnded).map(e => e.subagentId), [started.ref, ref2]);
});

test.each(routes)('$entry $parentBackend → $childBackend: stopping chain never starts or seals next link', async route => {
  const { first, second, started, ref2 } = await batchFixture(route, 'chain');
  first.text('partial');
  stopSubagentRun(started.id);
  await waitForSubagentRun(started.id, 1000);
  await conversationHistory.flush();
  assert.equal(second.prompts.length, 0);
  assert.equal(getSubagentChildStatuses(SESSION).has(ref2), false);
  assert.deepEqual(messages.filter(e => e.subagentEnded).map(e => [e.subagentId, e.subagentEnded]), [[started.ref, 'killed']]);
});

test.each(routes)('$entry $parentBackend → $childBackend: normal mode preserves rows without full tool payloads', async route => {
  vi.stubEnv('DEBUG', '');
  const child = new Child();
  const fixture = await parent(child);
  onTestFinished(() => fixture.engine.close());
  const active = await turn(fixture);
  const started = await spawn(fixture, route);
  await vi.waitFor(() => assert.ok(child.resolve));
  await finishParent(fixture, active);
  child.tool('compact-only'); child.text('visible prose'); child.resolve();
  await waitForSubagentRun(started.id, 1000);
  await assertQueries(started.ref, 1, ['visible prose']);
  const history = await conversationHistory.getHistory(SESSION);
  assert.ok(history?.events.every(e => !e.debug));
  assert.equal(await conversationHistory.getToolDebugDetails(SESSION, `${started.ref}:compact-only`), null);
});
