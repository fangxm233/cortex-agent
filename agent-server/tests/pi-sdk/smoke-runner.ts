// input:  Cortex createPiRuntime, real Pi SDK, local fixtures
// output: assertions for tools, context, persistence and quota
// pos:    Exercise the production Pi runtime without credentials
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadPiSdk } from '../../src/core/pi-sdk.js';
import type { CodexQuotaReading } from '../../src/core/codex-quota.js';
import {
  createPiRuntime, type PiRuntimeHandle, type PiRawEvent,
} from '../../src/agent-adapter/pi/runtime.js';
import {
  APPEND, MODEL, PROVIDER, SYSTEM, TODO_RESULT, mcpFixture, restrictFetch,
  sessionRequest, startProvider, type CapturedRequest, type ChatRequest,
} from './fixtures.js';

function assertSurface(body: ChatRequest): void {
  assert.equal(body.model, MODEL);
  assert.equal(body.stream, true);
  const system = body.messages.find(message => message.role === 'system');
  assert.ok(system);
  assert.match(String(system.content), new RegExp(SYSTEM));
  assert.match(String(system.content), new RegExp(APPEND));
  const tools = body.tools.map(tool => tool.function.name);
  assert.equal(new Set(tools).size, tools.length, 'no duplicate tools after discovery');
  for (const name of ['todo_write', 'smoke_echo', 'read']) assert.ok(tools.includes(name), name);
  assert.ok(body.tools.find(tool => tool.function.name === 'todo_write')?.function.parameters);
  assert.ok(body.tools.find(tool => tool.function.name === 'smoke_echo')?.function.parameters);
}

function assertToolResults(body: ChatRequest, turn: number): void {
  const results = body.messages.filter(message => message.role === 'tool');
  assert.ok(results.some(message => message.tool_call_id === `todo_${turn}`
    && message.content === TODO_RESULT));
  assert.ok(results.some(message => message.tool_call_id === `echo_${turn}`
    && message.content === `MCP:echo-${turn}`));
  const calls = body.messages.flatMap(message => message.tool_calls ?? []);
  assert.ok(calls.some(call => call.id === `todo_${turn}` && call.function.name === 'todo_write'));
  assert.ok(calls.some(call => call.id === `echo_${turn}` && call.function.name === 'smoke_echo'));
}

function assertRequests(requests: CapturedRequest[], turn: number): void {
  assert.equal(requests.length, turn * 2, 'each prompt needs a tool call and final reply');
  const first = requests.at(-2)!.body;
  const followup = requests.at(-1)!.body;
  assertSurface(first);
  assertSurface(followup);
  assert.equal(first.messages.at(-1)?.role, 'user');
  assert.match(JSON.stringify(first.messages.at(-1)?.content), new RegExp(`smoke user sentinel ${turn}`));
  assertToolResults(followup, turn);
  if (turn === 1) return;
  const previous = requests.at(-3)!.body;
  assert.deepEqual(first.tools, previous.tools, 'schemas survive subsequent turns and resume');
  assert.deepEqual(first.messages.slice(0, previous.messages.length), previous.messages,
    'all previous system/user/assistant/tool messages remain intact');
  assert.ok(first.messages.some(message => message.role === 'assistant'
    && message.content === `finished-${turn - 1}`));
  assertToolResults(first, turn - 1);
}

function assertEvents(events: PiRawEvent[], quotas: CodexQuotaReading[]): void {
  assert.equal(events.filter(event => event.type === 'agent_end').length, 3);
  assert.deepEqual(events.filter(event => event.type === 'extension_error'), []);
  const completed = events.filter(event => event.type === 'tool_execution_end');
  assert.equal(completed.length, 6);
  assert.ok(completed.every(event => event.isError === false));
  assert.deepEqual(completed.map(event => event.toolName).sort(),
    ['smoke_echo', 'smoke_echo', 'smoke_echo', 'todo_write', 'todo_write', 'todo_write']);
  assert.ok(events.some(event => event.type === 'message_update'), 'streaming events forwarded');
  assert.equal(quotas.length, 6, 'real response headers trigger every quota callback');
  for (const reading of quotas) assert.deepEqual(reading, {
    provider: 'openai-codex', planType: 'smoke',
    windows: [{ type: 'codex_primary', utilization: 0.25, resetsAt: 2000000000 }],
  });
}

async function assertTranscript(runtime: PiRuntimeHandle): Promise<string> {
  const file = runtime.session.sessionFile;
  assert.ok(file);
  const entries = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries[0].id, runtime.session.sessionId);
  const messages = entries.filter(entry => entry.type === 'message').map(entry => entry.message);
  assert.equal(messages.filter(message => message.role === 'toolResult').length, 4);
  assert.ok(messages.some(message => message.role === 'assistant'
    && message.content.some((block: { text?: string }) => block.text === 'finished-2')));
  return file;
}

async function exercise(provider: Awaited<ReturnType<typeof startProvider>>): Promise<void> {
  const sdk = await loadPiSdk(); // Deliberately never mocked: same import as production.
  assert.equal(sdk.VERSION, '0.87.1');
  const request = await sessionRequest(process.env.HOME!, provider.baseUrl);
  const mcp = mcpFixture();
  const events: PiRawEvent[] = [];
  const quotas: CodexQuotaReading[] = [];
  const callbacks = { onEvent: (event: PiRawEvent) => events.push(event),
    onProviderQuota: (reading: CodexQuotaReading) => quotas.push(reading) };
  let runtime = await createPiRuntime(request, callbacks, { openBundledMcpServer: mcp.open });
  try {
    assert.ok(runtime.session instanceof sdk.AgentSession);
    assert.equal(runtime.session.agent?.state.model?.provider, PROVIDER);
    await runTurns(runtime, provider.requests);
    const sessionPath = await assertTranscript(runtime);
    const sessionId = runtime.session.sessionId;
    await runtime.dispose();
    runtime = await createPiRuntime({ ...request, sessionPath }, callbacks, { openBundledMcpServer: mcp.open });
    assert.equal(runtime.session.sessionId, sessionId);
    await runtime.session.prompt('smoke user sentinel 3: resume persisted history');
    assertRequests(provider.requests, 3);
    assertFinished(runtime, 3);
    assertEvents(events, quotas);
    assert.deepEqual(mcp.calls, [{ value: 'echo-1' }, { value: 'echo-2' }, { value: 'echo-3' }]);
  } finally {
    await runtime.dispose();
    await runtime.dispose(); // Idempotent cleanup must not close MCP twice.
  }
  assert.deepEqual(mcp.counts(), { opened: 2, closed: 2 });
}

function assertFinished(runtime: PiRuntimeHandle, turn: number): void {
  assert.equal(runtime.session.isStreaming, false);
  const last = runtime.session.agent?.state.messages.at(-1);
  assert.ok(last?.role === 'assistant');
  assert.equal(last.stopReason, 'stop');
  assert.deepEqual(last.content, [{ type: 'text', text: `finished-${turn}` }]);
}

async function runTurns(runtime: PiRuntimeHandle, requests: CapturedRequest[]): Promise<void> {
  for (const turn of [1, 2]) {
    await runtime.session.prompt(`smoke user sentinel ${turn}: execute both tools`);
    assertRequests(requests, turn);
    assertFinished(runtime, turn);
  }
}

async function main(): Promise<void> {
  const provider = await startProvider();
  const network = restrictFetch(provider.baseUrl);
  try {
    await exercise(provider);
    assert.deepEqual(provider.errors, []);
    assert.deepEqual(network.blocked, []);
    console.log('PI_SDK_SMOKE_OK version=0.87.1 requests=6 tools=6 quota=6');
  } finally {
    network.restore();
    await provider.close();
  }
}

await main();
