// input:  PI adapter over a fake runtime, web responses, extension UI events
// output: Local shim gates, Agent, web, and generic dialog tests
// pos:    Tests PI-local tools and extension UI transport
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { mkdirSync } from 'node:fs';
import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import type { PIAgentProcess } from '../src/agent-adapter/pi/adapter.js';
import toolShims from '../src/agent-adapter/pi/tool-shims.js';
import { makeFakeRuntimeFactory, type FakeRuntime } from './agent-adapter/pi-fake-runtime.js';

const SESSION_DIR = pathJoin(tmpdir(), 'pi-shims-test-' + process.pid);
mkdirSync(SESSION_DIR, { recursive: true });

const WEB_FETCH_MAX_REDIRECTS = 5;
const WEB_FETCH_TIMEOUT_MS = 30_000;
const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024;
const WEB_FETCH_MAX_CHARACTERS = 100_000;
const WEB_FETCH_TRUNCATION_MARKER = '\n\n[Content truncated: WebFetch size limit exceeded.]';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** One adapter over a fake runtime whose session reports `sessionId`, with the runtime resolved. */
async function spawnSession(sessionKey: string, sessionId = 'sess-abc', config: Record<string, unknown> = {}) {
  const fake = makeFakeRuntimeFactory({ sessionId });
  const adapter = new PIAdapter(fake.factory, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey, sessionId: null, resume: false, ...config }) as PIAgentProcess;
  const runtime: FakeRuntime = await fake.runtime();
  return { fake, adapter, proc, runtime };
}

// Tests A-D: turn lifecycle over the in-process session
test('A: basic send', async () => {
  const { proc, runtime } = await spawnSession('k1');
  const turnPromise = proc.send({ text: 'hello' });
  await runtime.nextCall('prompt');
  runtime.emit({ type: 'agent_end', messages: [{ role: 'assistant', content: 'ok', usage: { cost: { total: 0.005 } } }] });
  runtime.emit({ type: 'agent_settled' });
  const result = await turnPromise;
  assert.equal(result.sessionId, 'sess-abc');
  assert.deepEqual(runtime.prompts(), ['hello']);
  await proc.close();
});

test('B: successful PI auto-retry does not mark the settled turn rate-limited', async () => {
  const { proc, runtime } = await spawnSession('k2');
  const turnPromise = proc.send({ text: 'do stuff' });
  await runtime.nextCall('prompt');
  const transientError = 'Codex error: An error occurred while processing your request. You can retry your request.';
  runtime.emit({ type: 'agent_end', messages: [{
    role: 'assistant', stopReason: 'error', errorMessage: transientError,
  }] });
  runtime.emit({ type: 'auto_retry_start', attempt: 1, errorMessage: transientError });
  runtime.emit({ type: 'auto_retry_end', success: true, attempt: 1 });
  runtime.emit({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] });
  runtime.emit({ type: 'agent_settled' });
  const result = await turnPromise;
  assert.equal(result.rateLimited, false);
  await proc.close();
});

test('B2: exhausted PI auto-retry rejects with the final provider error', async () => {
  const { proc, runtime } = await spawnSession('k2-failed');
  const turnPromise = proc.send({ text: 'do stuff' });
  const rejection = assert.rejects(turnPromise, /You can retry your request/);
  await runtime.nextCall('prompt');
  const finalError = 'Codex error: An error occurred while processing your request. You can retry your request.';
  runtime.emit({ type: 'agent_end', messages: [{
    role: 'assistant', stopReason: 'error', errorMessage: finalError,
  }] });
  runtime.emit({ type: 'auto_retry_end', success: false, attempt: 3, finalError });
  runtime.emit({ type: 'agent_settled' });
  await rejection;
  await proc.close();
});

test('C: sendExtensionUiResponse', async () => {
  const { proc, runtime } = await spawnSession('k3');
  proc.sendExtensionUiResponse('ui-req-1', { confirmed: true });
  assert.deepEqual(runtime.uiResponses, [{ id: 'ui-req-1', payload: { confirmed: true } }]);
  await proc.close();
});

test('D: sendExtensionUiResponse with value', async () => {
  const { proc, runtime } = await spawnSession('k4');
  proc.sendExtensionUiResponse('ui-req-2', { value: 'Option A' });
  assert.deepEqual(runtime.uiResponses, [{ id: 'ui-req-2', payload: { value: 'Option A' } }]);
  await proc.close();
});

// Test F: generic extension dialog routing remains available
test('F: generic extension dialog', async () => {
  const { proc, runtime } = await spawnSession('k6');
  const turnPromise = proc.send({ text: 'ask me something' });
  await runtime.nextCall('prompt');
  runtime.emit({ type: 'extension_ui_request', id: 'ui-sel-1', method: 'select', title: 'What color?', options: ['Red', 'Blue'] });
  proc.sendExtensionUiResponse('ui-sel-1', { value: 'Blue' });
  runtime.emit({ type: 'agent_end', messages: [] });
  runtime.emit({ type: 'agent_settled' });
  const result = await turnPromise;
  assert.equal(result.askUserQuestions, undefined);
  assert.deepEqual(runtime.uiResponses, [{ id: 'ui-sel-1', payload: { value: 'Blue' } }]);
  await proc.close();
});

// Test G: the prompt is refused before PI enters its loop (auth/model failure)
test('G: fatal error', async () => {
  const { proc, runtime } = await spawnSession('k7');
  runtime.promptRejections.push(new Error('fatal: something broke'));
  const turnPromise = proc.send({ text: 'do something' });
  await assert.rejects(turnPromise, /something broke/i);
  await proc.close().catch(() => {});
});

// Test H: the session is closed while a turn is still waiting on PI
test('H: session closed before turn_complete', async () => {
  const { adapter, proc } = await spawnSession('k8');
  const turnPromise = proc.send({ text: 'do work' });
  const rejection = assert.rejects(turnPromise, /closed before turn_complete/i);
  await adapter.close('k8');
  await rejection;
  await proc.close().catch(() => {});
});

// ─── Tool allowlist gating (thread agents must not get interaction tools) ───

function makeMockPi() {
  const registered: string[] = [];
  const definitions = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const pi: any = {
    on: (event: string, handler: (event: any, ctx: any) => any) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: (def: any) => {
      registered.push(def.name);
      definitions.set(def.name, def);
    },
  };
  const emit = async (event: string, ctx: any) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
  };
  return { pi, registered, definitions, handlers, emit };
}

const CODER_TOOLS = 'Agent,Bash,Edit,Glob,Grep,Read,Skill,TaskStop,TodoWrite,WebFetch,WebSearch,Write';

test('J: coder allowlist registers one Agent at session start', async () => {
  const prev = process.env.CORTEX_PI_ALLOWED_TOOLS;
  const previousSubagent = process.env.CORTEX_PI_SUBAGENT;
  process.env.CORTEX_PI_ALLOWED_TOOLS = CODER_TOOLS;
  delete process.env.CORTEX_PI_SUBAGENT;
  try {
    const { pi, registered, handlers, emit } = makeMockPi();
    toolShims(pi);
    assert.ok(!registered.includes('ask_user_question'));
    assert.ok(!registered.includes('enter_plan_mode'));
    assert.ok(!registered.includes('exit_plan_mode'));
    assert.ok(!registered.includes('agent'), 'Agent must wait for the runtime model catalog');
    assert.equal(handlers.get('session_start')?.length, 1);
    assert.ok(registered.includes('todo_write'));
    assert.ok(registered.includes('web_fetch'));
    assert.ok(registered.includes('web_search'));

    await emit('session_start', {
      model: { provider: 'openai-codex', id: 'active-model' },
      modelRegistry: {
        getAvailable: () => [
          { provider: 'openai-codex', id: 'catalog-model' },
          { provider: 'deepseek', id: 'deepseek-v4-flash' },
        ],
      },
    });

    assert.equal(registered.filter((name) => name === 'agent').length, 1);
  } finally {
    if (prev === undefined) delete process.env.CORTEX_PI_ALLOWED_TOOLS;
    else process.env.CORTEX_PI_ALLOWED_TOOLS = prev;
    if (previousSubagent === undefined) delete process.env.CORTEX_PI_SUBAGENT;
    else process.env.CORTEX_PI_SUBAGENT = previousSubagent;
  }
});

test('J2: unset allowlist exposes only the remaining local shims', async () => {
  const prev = process.env.CORTEX_PI_ALLOWED_TOOLS;
  const previousSubagent = process.env.CORTEX_PI_SUBAGENT;
  delete process.env.CORTEX_PI_ALLOWED_TOOLS;
  delete process.env.CORTEX_PI_SUBAGENT;
  try {
    const { pi, registered, emit } = makeMockPi();
    toolShims(pi);
    await emit('session_start', {
      model: { provider: 'openai-codex', id: 'active-model' },
      modelRegistry: { getAvailable: () => [] },
    });
    for (const name of ['agent', 'todo_write', 'web_fetch', 'web_search']) {
      assert.ok(registered.includes(name), `${name} should be registered when no allowlist is set`);
    }
    for (const name of ['ask_user_question', 'enter_plan_mode', 'exit_plan_mode']) {
      assert.equal(registered.includes(name), false, `${name} is provided by the shared MCP bridge`);
    }
  } finally {
    if (prev === undefined) delete process.env.CORTEX_PI_ALLOWED_TOOLS;
    else process.env.CORTEX_PI_ALLOWED_TOOLS = prev;
    if (previousSubagent === undefined) delete process.env.CORTEX_PI_SUBAGENT;
    else process.env.CORTEX_PI_SUBAGENT = previousSubagent;
  }
});

test('J2b: CORTEX_PI_SUBAGENT prevents recursive Agent registration', () => {
  const previousAllowed = process.env.CORTEX_PI_ALLOWED_TOOLS;
  const previousSubagent = process.env.CORTEX_PI_SUBAGENT;
  process.env.CORTEX_PI_ALLOWED_TOOLS = 'Agent,TodoWrite,WebFetch';
  process.env.CORTEX_PI_SUBAGENT = '1';
  try {
    const { pi, registered, handlers } = makeMockPi();
    toolShims(pi);
    assert.ok(!registered.includes('agent'));
    assert.equal(handlers.get('session_start'), undefined);
    assert.ok(registered.includes('todo_write'));
    assert.ok(registered.includes('web_fetch'));
  } finally {
    if (previousAllowed === undefined) delete process.env.CORTEX_PI_ALLOWED_TOOLS;
    else process.env.CORTEX_PI_ALLOWED_TOOLS = previousAllowed;
    if (previousSubagent === undefined) delete process.env.CORTEX_PI_SUBAGENT;
    else process.env.CORTEX_PI_SUBAGENT = previousSubagent;
  }
});

function makeWebFetchTool(): any {
  const prev = process.env.CORTEX_PI_ALLOWED_TOOLS;
  delete process.env.CORTEX_PI_ALLOWED_TOOLS;
  try {
    const { pi, definitions } = makeMockPi();
    toolShims(pi);
    const tool = definitions.get('web_fetch');
    assert.ok(tool, 'web_fetch should be registered');
    return tool;
  } finally {
    if (prev === undefined) delete process.env.CORTEX_PI_ALLOWED_TOOLS;
    else process.env.CORTEX_PI_ALLOWED_TOOLS = prev;
  }
}

function executeWebFetch(tool: any, params: Record<string, unknown>, signal?: AbortSignal) {
  return tool.execute('tc-web-fetch', params, signal, undefined, {});
}

function mockPendingFetch(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((_input: any, init?: RequestInit) => (
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  ) as Promise<Response>);
}

function makeTrackedBody(content: string | Uint8Array, closeAfterStart = false) {
  let cancelled = false;
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        if (closeAfterStart) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
    wasCancelled: () => cancelled,
  };
}

test('J4: toolShims excludes web tools when the allowlist omits them', () => {
  const prev = process.env.CORTEX_PI_ALLOWED_TOOLS;
  process.env.CORTEX_PI_ALLOWED_TOOLS = 'Read,Grep';
  try {
    const { pi, registered } = makeMockPi();
    toolShims(pi);
    assert.ok(!registered.includes('agent'));
    assert.ok(!registered.includes('web_fetch'));
    assert.ok(!registered.includes('web_search'));
  } finally {
    if (prev === undefined) delete process.env.CORTEX_PI_ALLOWED_TOOLS;
    else process.env.CORTEX_PI_ALLOWED_TOOLS = prev;
  }
});

test('J5: WebFetch preserves HTML headings, links, tables, and code while removing inactive content', async () => {
  const tool = makeWebFetchTool();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`
    <html><head><style>.hidden { color: red; }</style><script>bad()</script></head>
    <body>
      <h1>Example heading</h1>
      <p>Visit <a href="/docs">the docs</a> and call <code>inline()</code>.</p>
      <table><thead><tr><th>Name</th><th>Value</th></tr></thead>
      <tbody><tr><td>alpha</td><td>1</td></tr></tbody></table>
      <pre><code>const answer = 42;</code></pre>
      <noscript>noscript text</noscript><iframe>iframe text</iframe>
    </body></html>
  `, { headers: { 'content-type': 'text/html; charset=utf-8' } }));

  const result = await executeWebFetch(tool, { url: 'https://example.test/page' });
  const text = result.content[0].text;
  assert.match(text, /^# Example heading/m);
  assert.match(text, /\[the docs\]\(\/docs\)/);
  assert.match(text, /\|\s*Name\s*\|\s*Value\s*\|/);
  assert.match(text, /`inline\(\)`/);
  assert.match(text, /```\s*\nconst answer = 42;\s*\n```/);
  for (const removed of ['bad()', '.hidden', 'noscript text', 'iframe text']) {
    assert.ok(!text.includes(removed), `${removed} should be removed`);
  }
});

test('J5b: WebFetch omits embedded image data URLs while preserving external images', async () => {
  const tool = makeWebFetchTool();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`
    <p><img alt="inline graph" src="data:image/png;base64,INLINE_IMAGE_PAYLOAD"></p>
    <p><img alt="external graph" src="https://cdn.example.test/graph.png"></p>
  `, { headers: { 'content-type': 'text/html' } }));

  const result = await executeWebFetch(tool, { url: 'https://example.test/images' });
  const text = result.content[0].text;
  assert.match(text, /\[Embedded image omitted\]/);
  assert.match(text, /!\[external graph\]\(https:\/\/cdn\.example\.test\/graph\.png\)/);
  assert.ok(!text.includes('data:'));
  assert.ok(!text.includes('INLINE_IMAGE_PAYLOAD'));
});

test('J6: WebFetch passes JSON and plain text through and ignores the compatibility prompt', async () => {
  const tool = makeWebFetchTool();
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('{"ok":true}', {
      headers: { 'content-type': 'application/problem+json' },
    }))
    .mockResolvedValueOnce(new Response('plain text\nunchanged', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }));

  const json = await executeWebFetch(tool, {
    url: 'https://example.test/data',
    prompt: 'Summarize this with another model',
  });
  const text = await executeWebFetch(tool, { url: 'https://example.test/plain' });
  assert.equal(json.content[0].text, '{"ok":true}');
  assert.equal(text.content[0].text, 'plain text\nunchanged');
  assert.equal(fetchSpy.mock.calls.length, 2);
});

test('J7: WebFetch accepts loopback HTTP but rejects non-HTTP protocols before fetching', async () => {
  const tool = makeWebFetchTool();
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('local', {
    headers: { 'content-type': 'text/plain' },
  }));

  const local = await executeWebFetch(tool, { url: 'http://127.0.0.1/private' });
  assert.equal(local.content[0].text, 'local');
  await assert.rejects(
    executeWebFetch(tool, { url: 'file:///etc/passwd' }),
    /only supports http and https/i,
  );
  assert.equal(fetchSpy.mock.calls.length, 1);
});

test('J8: WebFetch follows relative redirects manually and enforces the redirect cap', async () => {
  const tool = makeWebFetchTool();
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: '/final' },
    }))
    .mockResolvedValueOnce(new Response('done', {
      headers: { 'content-type': 'text/plain' },
    }));

  const result = await executeWebFetch(tool, { url: 'https://example.test/start' });
  assert.equal(result.content[0].text, 'done');
  assert.equal(fetchSpy.mock.calls[1][0], 'https://example.test/final');
  assert.equal(fetchSpy.mock.calls[0][1]?.redirect, 'manual');

  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(new Response(null, {
    status: 302,
    headers: { location: '/again' },
  }));
  await assert.rejects(
    executeWebFetch(tool, { url: 'https://example.test/loop' }),
    /redirect limit.*5/i,
  );
  assert.equal(fetchSpy.mock.calls.length, WEB_FETCH_MAX_REDIRECTS + 1);
});

test('J8b: WebFetch cancels malformed redirect bodies before rejecting', async () => {
  const tool = makeWebFetchTool();
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const cases = [
    { location: undefined, error: /redirect without a location/i },
    { location: 'http://[invalid', error: /invalid redirect target/i },
    { location: 'file:///tmp/redirected', error: /only supports http and https/i },
  ];

  for (const redirect of cases) {
    const trackedBody = makeTrackedBody('redirect body');
    fetchSpy.mockResolvedValueOnce(new Response(trackedBody.body, {
      status: 302,
      headers: redirect.location ? { location: redirect.location } : undefined,
    }));

    await assert.rejects(
      executeWebFetch(tool, { url: 'https://example.test/redirect' }),
      redirect.error,
    );
    assert.equal(
      trackedBody.wasCancelled(),
      true,
      `body was retained for ${redirect.location ?? 'no Location'}`,
    );
  }
});

test('J9: WebFetch enforces its timeout and propagates parent cancellation', async () => {
  vi.useFakeTimers();
  const tool = makeWebFetchTool();
  mockPendingFetch();

  const timeoutPromise = executeWebFetch(tool, { url: 'https://example.test/slow' });
  const timeoutRejection = assert.rejects(timeoutPromise, /timed out.*30000 ms/i);
  await vi.advanceTimersByTimeAsync(WEB_FETCH_TIMEOUT_MS);
  await timeoutRejection;

  const controller = new AbortController();
  const cancelledPromise = executeWebFetch(
    tool,
    { url: 'https://example.test/cancelled' },
    controller.signal,
  );
  const cancelledRejection = assert.rejects(cancelledPromise, /abort/i);
  controller.abort();
  await cancelledRejection;
});

test('J10: WebFetch truncates oversized text with an explicit marker and cancels the body', async () => {
  const tool = makeWebFetchTool();
  let bodyCancelled = false;
  const oversizedChunk = new TextEncoder().encode('x'.repeat(WEB_FETCH_MAX_BYTES + 1));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(oversizedChunk);
    },
    cancel() {
      bodyCancelled = true;
    },
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, {
    headers: { 'content-type': 'text/plain' },
  }));

  const result = await executeWebFetch(tool, { url: 'https://example.test/large' });
  const text = result.content[0].text;
  assert.equal(text.slice(0, -WEB_FETCH_TRUNCATION_MARKER.length).length, WEB_FETCH_MAX_CHARACTERS);
  assert.ok(text.endsWith(WEB_FETCH_TRUNCATION_MARKER));
  assert.equal(bodyCancelled, true);
});

test('J11: WebFetch rejects HTTP errors, missing media types, and binary content explicitly', async () => {
  const tool = makeWebFetchTool();
  const binaryBody = makeTrackedBody(new Uint8Array([0, 1, 2]));
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('not found', {
      status: 404,
      headers: { 'content-type': 'text/plain' },
    }))
    .mockResolvedValueOnce(new Response(new TextEncoder().encode('unknown')))
    .mockResolvedValueOnce(new Response(binaryBody.body, {
      headers: { 'content-type': 'application/octet-stream' },
    }));

  await assert.rejects(
    executeWebFetch(tool, { url: 'https://example.test/missing' }),
    /http 404/i,
  );
  await assert.rejects(
    executeWebFetch(tool, { url: 'https://example.test/no-type' }),
    /missing content-type/i,
  );
  await assert.rejects(
    executeWebFetch(tool, { url: 'https://example.test/file.bin' }),
    /unsupported binary content-type.*application\/octet-stream/i,
  );
  assert.equal(binaryBody.wasCancelled(), true);
});

test('J11b: WebFetch rejects non-application structured JSON suffixes', async () => {
  const tool = makeWebFetchTool();
  const body = makeTrackedBody('not-json-binary', true);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body.body, {
    headers: { 'content-type': 'image/example+json' },
  }));

  await assert.rejects(
    executeWebFetch(tool, { url: 'https://example.test/non-application-json' }),
    /unsupported binary content-type.*image\/example\+json/i,
  );
  assert.equal(body.wasCancelled(), true);
});

test('K: spawn forwards rawTools allowlist to the session env', async () => {
  const { fake, proc } = await spawnSession('kEnv', 'sess-abc', { rawTools: CODER_TOOLS });
  assert.equal(fake.requests[0].env.CORTEX_PI_ALLOWED_TOOLS, CODER_TOOLS);
  await proc.close();
});

test('K2: spawn omits CORTEX_PI_ALLOWED_TOOLS when rawTools is unset', async () => {
  const prev = process.env.CORTEX_PI_ALLOWED_TOOLS;
  delete process.env.CORTEX_PI_ALLOWED_TOOLS;
  try {
    const { fake, proc } = await spawnSession('kEnv2');
    assert.equal(fake.requests[0].env.CORTEX_PI_ALLOWED_TOOLS, undefined);
    await proc.close();
  } finally {
    if (prev !== undefined) process.env.CORTEX_PI_ALLOWED_TOOLS = prev;
  }
});

console.error("All tests registered");
