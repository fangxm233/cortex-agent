// Real adapters over scripted Claude children and the PI fake runtime. A run never retries;
// classification still drives provider attribution, auth recovery, and rate-limit notices.
import { afterEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { isRetryableError, configIsRateLimited } from '../src/domain/runs/fallback.js';
import { AgentRunImpl, type RunTerminalInfo } from '../src/domain/runs/run.js';
import type { RunRequest } from '../src/domain/runs/request.js';
import type { RunEvent } from '../src/agent-adapter/run-events.js';
import type { EngineSelection } from '../src/domain/agents/engine-selection.js';
import { EventBus } from '../src/events/event-bus.js';
import type { CortexEvent } from '../src/events/index.js';
import { classifyAuthError, initAuthEvents } from '../src/domain/auth/auth-events.js';
import { activateOutageWindow, handleRateLimitEvent, initRateLimitThrottle, _testReset as throttleReset } from '../src/domain/costs/rate-limit-throttle.js';
import { MockAdapter } from '../src/platform/testing.js';
import { RunRegistry } from '../src/core/run-registry.js';
import { CAPABILITIES_BY_BACKEND } from '../src/agent-adapter/capabilities.js';
import { runRequestFixture } from './run-request-fixture.js';
import { makeFakeRuntimeFactory } from './agent-adapter/pi-fake-runtime.js';

const fixtures = vi.hoisted(() => ({
  current: null as unknown as ReturnType<typeof makeFakeRuntimeFactory>,
  engines: null as unknown as import('../src/domain/runs/engines.js').SessionEngines,
}));
vi.mock('../src/domain/runs/engines.js', async (original) => {
  const actual = await original<typeof import('../src/domain/runs/engines.js')>();
  const { PIAdapter } = await import('../src/agent-adapter/pi/adapter.js');
  const { ClaudeAdapter } = await import('../src/agent-adapter/claude/adapter.js');
  fixtures.engines = new actual.SessionEngines({
    pi: new PIAdapter((request, callbacks) => fixtures.current.factory(request, callbacks)),
    claude: new ClaudeAdapter(),
  });
  return { ...actual, engines: fixtures.engines };
});
const children: any[] = [];
const PI: EngineSelection = { backend: 'pi', mode: 'deepseek', provider: 'deepseek', model: 'deepseek-fixture', thinking: null };
let serial = 0;
afterEach(async () => {
  for (const key of fixtures.engines.listKeys()) await fixtures.engines.close(key);
  for (const child of children.splice(0)) child.emit('close', 0);
  initAuthEvents(null);
  throttleReset();
});
function child(lines: unknown[]): any {
  const process = new EventEmitter() as any;
  process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.stdin = new PassThrough();
  process.exitCode = null; process.kill = () => true;
  process.stdin.once('data', () => setImmediate(() => {
    for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
  }));
  children.push(process);
  return process;
}
function request(backend: 'pi' | 'claude' = 'pi', lines: unknown[] = []): RunRequest {
  return runRequestFixture({
    channel: 'web:retry', sessionKey: `run-${++serial}`, trackSessionId: 'track',
    loadCortexRules: false, recordCost: false,
    processSpawner: (() => ({ process: child(lines) })) as never,
  }, backend === 'pi' ? PI : { backend: 'claude', mode: 'plan', provider: null });
}
function open(req: RunRequest) {
  const events: RunEvent[] = [];
  let terminal!: RunTerminalInfo;
  const registry = new RunRegistry();
  const run = new AgentRunImpl({
    request: req, observers: [{ onEvent: event => { events.push(event); } }],
    executionId: req.runId, registry, startedAt: Date.now(), onTerminal: info => { terminal = info; },
  });
  run.start();
  return { run, events, registry, terminal: () => terminal };
}
function notices(events: RunEvent[]) {
  return events.filter((event): event is Extract<RunEvent, { type: 'assistant_text' }> => event.type === 'assistant_text')
    .map(event => ({ text: event.text, level: event.noticeLevel }));
}
async function piOutcome(message?: string, tool = false, cost?: number, prose?: string) {
  const runtime = await fixtures.current.runtime(fixtures.current.runtimes.length - 1);
  await runtime.nextCall('prompt');
  runtime.emitAgentStart();
  if (tool) runtime.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'make deploy' } });
  if (prose) runtime.emitAssistantText(prose);
  runtime.emitAgentEnd({
    ...(message ? { stopReason: 'error', errorMessage: message } : {}),
    ...(cost === undefined ? {} : { usage: { input: 100, output: 10, cost: { total: cost } }, provider: 'deepseek' }),
  });
}
const resultLine = (message?: string, cost = 0) => ({
  type: 'result', subtype: message ? 'error' : 'success', is_error: !!message,
  num_turns: 1, total_cost_usd: cost, session_id: 'claude-session', result: message ?? 'ok',
});
async function throttle(provider: string, outage = false) {
  throttleReset();
  await initRateLimitThrottle(new MockAdapter({ adminChannel: 'admin' }), { save: async () => {}, load: async () => null });
  if (outage) await activateOutageWindow(provider, 300_000);
  else await handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.95, resetsAt: Math.floor(Date.now() / 1000) + 300 },
    { provider, displayName: provider, mode: provider === 'anthropic' ? 'plan' : provider },
  );
}

test.each([
  '502: {"message":"Upstream connection error: TypeError: fetch failed"}',
  'HTTP 408 Request Timeout', 'status code 500: internal server error', 'HTTP 503 Service Unavailable',
  'HTTP 504 Gateway Timeout', 'read ECONNRESET', 'connect ECONNREFUSED 127.0.0.1:443',
  'getaddrinfo EAI_AGAIN api.deepseek.com', 'network request timed out', 'Connection error.',
  'Codex error: An error occurred while processing your request. You can retry your request. Request ID: req_123',
  'You have hit your ChatGPT usage limit (prolite plan). Try again in ~7737 min.',
  "ENOSPC: no space left on device, write", 'EMFILE: too many open files, open', 'spawn ENFILE',
  'read EAGAIN',
])('classifies transient provider failure: %s', message => {
  expect(isRetryableError(new Error(message))).toBe(true);
});
test.each([
  'Please run /login', 'OAuth token has expired', 'authentication_error', 'invalid x-api-key',
  'HTTP 401: token rejected. You can retry your request.', 'invalid_grant', 'invalid_request',
  'unauthorized upstream connection error', 'connection timed out during authentication',
  'authentication service upstream connection error', 'authentication failed', 'Authentication error: token expired',
  'forbidden', 'model not found', 'request body too large', 'context window exceeded',
  'insufficient_balance', 'billing unavailable', 'quota exhausted', 'HTTP 400 invalid request',
  'HTTP 403 forbidden', 'HTTP 404 model not found', 'insufficient balance: billing quota exhausted',
  'processed 500 input tokens successfully', 'EAGAINST policy', 'XENOSPC',
])('classifies permanent failure: %s', message => {
  expect(isRetryableError(new Error(message))).toBe(false);
});
test.each([
  ['unauthorized upstream connection error', 'unauthorized'],
  ['connection timed out during authentication', 'invalid_api_key'],
  ['authentication service upstream connection error', 'invalid_api_key'],
  ['authentication failed', 'invalid_api_key'], ['Authentication error: token expired', 'invalid_api_key'],
])('preserves auth classification: %s', (message, kind) => expect(classifyAuthError(message)).toBe(kind));

test.each([
  ['claude', 'plan', 'anthropic', 'oauth', 'Please run /login', 'login_required'],
  ['claude', 'api', 'anthropic', 'api_key', 'invalid x-api-key', 'invalid_api_key'],
  ['pi', 'deepseek', 'deepseek', null, 'authentication failed', 'invalid_api_key'],
] as const)('auth required/recovered remains provider scoped: %s %s', async (backend, mode, provider, authType, message, kind) => {
  fixtures.current = makeFakeRuntimeFactory();
  const bus = new EventBus();
  const required: CortexEvent[] = [], recovered: CortexEvent[] = [];
  bus.subscribe('auth.required', event => { required.push(event); });
  bus.subscribe('auth.recovered', event => { recovered.push(event); });
  initAuthEvents(bus);
  for (const failure of [message, 'context window exceeded', 'rate limit exceeded', undefined, undefined]) {
    const req = request(backend, [resultLine(failure)]);
    req.selection.mode = mode;
    const { run } = open(req);
    if (backend === 'pi') await piOutcome(failure);
    if (failure && !(backend === 'claude' && failure === 'rate limit exceeded')) await expect(run.settled).rejects.toThrow(failure);
    else await run.settled;
    expect(recovered).toHaveLength(failure ? 0 : 1);
  }
  expect(required).toHaveLength(1);
  expect(required[0]).toMatchObject({ backend, provider, authType, kind, channel: 'web:retry', sessionId: 'track' });
  expect(recovered[0]).toMatchObject({ backend, provider });
});

test.each([false, true])('PI transport and rate-limit failures never switch engines, toolStarted=%s', async tool => {
  for (const message of ['read ECONNRESET', 'HTTP 429 rate limit exceeded']) {
    fixtures.current = makeFakeRuntimeFactory({ sessionId: 'pi-original' });
    const { run, events, registry } = open(request());
    await piOutcome(message, tool);
    await expect(run.settled).rejects.toThrow(message);
    expect(fixtures.current.runtimes).toHaveLength(1);
    expect(children).toHaveLength(0);
    expect(run.attempt.index).toBe(0);
    expect(run.capabilities).toBe(CAPABILITIES_BY_BACKEND.pi);
    expect(run.backendSessionId).toBe('pi-original');
    expect(notices(events)).toEqual([{ text: `Error: ${message}`, level: 'error' }]);
    expect(registry.getById(run.executionId)?.backend ?? 'pi').toBe('pi');
  }
});
test.each([false, true])('Claude rate-limited result is terminal with spend, toolStarted=%s', async tool => {
  const lines: unknown[] = tool ? [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'make deploy' } }] } }] : [];
  lines.push(resultLine('rate limit exceeded', 0.1));
  const h = open(request('claude', lines));
  expect((await h.run.settled).rateLimited).toBe(true);
  expect(h.run.status).toBe('rate-limited');
  expect(children).toHaveLength(1);
  expect(h.terminal().spend.costUsd).toBeCloseTo(0.1);
  expect(h.terminal().spend.numTurns).toBe(1);
});
test.each(['HTTP 429 rate limit exceeded', 'context window exceeded'])('failed PI spend survives without a result: %s', async message => {
  fixtures.current = makeFakeRuntimeFactory();
  const h = open(request());
  await piOutcome(message, false, 0.25);
  await expect(h.run.settled).rejects.toThrow(message);
  expect(h.terminal().result).toBeNull();
  expect(h.terminal().spend.costUsd).toBeCloseTo(0.25);
});
test('provider outage blocks automated work but a person bypasses the cache', async () => {
  await throttle('deepseek', true);
  expect(configIsRateLimited(PI)).toBe(true);
  fixtures.current = makeFakeRuntimeFactory();
  const blocked = open(request());
  expect((await blocked.run.settled).rateLimited).toBe(true);
  expect(fixtures.current.runtimes).toHaveLength(0);
  const req = request(); req.context.isUserInitiated = true;
  const h = open(req);
  await piOutcome();
  await h.run.settled;
  expect(fixtures.current.runtimes).toHaveLength(1);
});
test.each(['claude', 'pi'] as const)('user rate-limit outcome offers auto-resume: %s', async backend => {
  await throttle(backend === 'claude' ? 'anthropic' : 'deepseek');
  fixtures.current = makeFakeRuntimeFactory();
  const req = request(backend, [resultLine('rate limit exceeded')]); req.context.isUserInitiated = true;
  const h = open(req);
  if (backend === 'pi') await piOutcome('HTTP 429 rate limit exceeded');
  await h.run.settled.catch(() => undefined);
  expect(notices(h.events)).toEqual([{ text: 'Rate limited — this chat will resume automatically when the limit resets.', level: 'warning' }]);
});
test.each(['API Error: 400 invalid_request', 'API Error: Unable to connect to API (ECONNRESET)'])('terminal API notices are never duplicated: %s', async message => {
  fixtures.current = makeFakeRuntimeFactory();
  const h = open(request());
  await piOutcome(message, false, undefined, message);
  await expect(h.run.settled).rejects.toThrow(message);
  expect(notices(h.events)).toEqual([{ text: message, level: 'error' }]);
});
test('non-Web failures and user cancellation do not synthesize error notices', async () => {
  fixtures.current = makeFakeRuntimeFactory();
  const req = request(); req.context.channel = 'slack:C1';
  const failed = open(req);
  await piOutcome('HTTP 401 unauthorized');
  await expect(failed.run.settled).rejects.toThrow('401 unauthorized');
  expect(notices(failed.events)).toEqual([]);
  const cancelled = open(request());
  cancelled.run.cancel('user');
  await expect(cancelled.run.settled).rejects.toThrow(/cancelled/i);
  expect(notices(cancelled.events)).toEqual([]);
});
