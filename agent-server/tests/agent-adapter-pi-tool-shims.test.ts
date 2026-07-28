// input:  PIAdapter stub, fetch responses, extension-ui events
// output: PI shims, web media/gates, retry and turn tests
// pos:    PI pseudo-tool and local web regression coverage
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { mkdirSync } from 'node:fs';
import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import type { PIAgentProcess } from '../src/agent-adapter/pi/adapter.js';
import toolShims, { makeToolGate } from '../src/agent-adapter/pi/tool-shims.js';

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

function makeStubChild(): any {
  const emitter = new EventEmitter() as any;
  const stdin = new PassThrough() as any;
  stdin.writeHistory = [] as string[];
  const origWrite = stdin.write.bind(stdin);
  stdin.write = (chunk: any, ...rest: any[]) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    stdin.writeHistory.push(s);
    return origWrite(chunk, ...rest);
  };
  emitter.stdin = stdin;
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.__killed = false;
  emitter.kill = () => { if (emitter.__killed) return false; emitter.__killed = true; return true; };
  return emitter;
}

function makeStubSpawner() {
  const children: any[] = [];
  return { children, spawn: () => { const c = makeStubChild(); children.push(c); return c; } };
}

function pushLine(child: any, obj: any) { child.stdout.write(JSON.stringify(obj) + '\n'); }

async function bootstrap(child: any, sessionId = 'sess-abc') {
  pushLine(child, { type: 'response', id: 'bootstrap', command: 'get_state', success: true, data: { sessionId } });
  await Promise.resolve();
}

// Tests A-D (same as before)
test('A: basic send', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k1', sessionId: null, resume: false });
  const child = s.children[0];
  await bootstrap(child);
  const turnPromise = proc.send({ text: 'hello' });
  pushLine(child, { type: 'agent_end', messages: [{ role: 'assistant', content: 'ok', usage: { cost: { total: 0.005 } } }] });
  pushLine(child, { type: 'agent_settled' });
  await Promise.resolve();
  const result = await turnPromise;
  assert.equal(result.sessionId, 'sess-abc');
  child.emit('close', 0);
  await proc.close();
});

test('B: successful PI auto-retry does not mark the settled turn rate-limited', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k2', sessionId: null, resume: false });
  const child = s.children[0];
  await bootstrap(child);
  const turnPromise = proc.send({ text: 'do stuff' });
  const transientError = 'Codex error: An error occurred while processing your request. You can retry your request.';
  pushLine(child, { type: 'agent_end', messages: [{
    role: 'assistant', stopReason: 'error', errorMessage: transientError,
  }] });
  pushLine(child, { type: 'auto_retry_start', attempt: 1, errorMessage: transientError });
  pushLine(child, { type: 'auto_retry_end', success: true, attempt: 1 });
  pushLine(child, { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] });
  pushLine(child, { type: 'agent_settled' });
  await Promise.resolve();
  const result = await turnPromise;
  assert.equal(result.rateLimited, false);
  child.emit('close', 0);
  await proc.close();
});

test('B2: exhausted PI auto-retry rejects with the final provider error', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k2-failed', sessionId: null, resume: false });
  const child = s.children[0];
  await bootstrap(child);
  const turnPromise = proc.send({ text: 'do stuff' });
  const rejection = assert.rejects(turnPromise, /You can retry your request/);
  const finalError = 'Codex error: An error occurred while processing your request. You can retry your request.';
  pushLine(child, { type: 'agent_end', messages: [{
    role: 'assistant', stopReason: 'error', errorMessage: finalError,
  }] });
  pushLine(child, { type: 'auto_retry_end', success: false, attempt: 3, finalError });
  pushLine(child, { type: 'agent_settled' });
  await rejection;
  child.emit('close', 0);
  await proc.close();
});

test('C: sendExtensionUiResponse', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k3', sessionId: null, resume: false }) as PIAgentProcess;
  const child = s.children[0];
  await bootstrap(child);
  proc.sendExtensionUiResponse('ui-req-1', { confirmed: true });
  const written = child.stdin.writeHistory.find((w: string) => w.includes('extension_ui_response'));
  assert.ok(written);
  child.emit('close', 0);
  await proc.close();
});

test('D: sendExtensionUiResponse with value', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k4', sessionId: null, resume: false }) as PIAgentProcess;
  const child = s.children[0];
  await bootstrap(child);
  proc.sendExtensionUiResponse('ui-req-2', { value: 'Option A' });
  const written = child.stdin.writeHistory.find((w: string) => w.includes('extension_ui_response'));
  assert.ok(written);
  child.emit('close', 0);
  await proc.close();
});

// Test E: plan->approval->resume (complex flow)
test('E: plan flow', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k5', sessionId: null, resume: false }) as PIAgentProcess;
  const child = s.children[0];
  await bootstrap(child);
  const turnPromise = proc.send({ text: 'build a feature' });

  const PLAN_PATH = '/repo/plan/my-plan.md';
  pushLine(child, { type: 'tool_execution_start', toolCallId: 'tc-write', toolName: 'write', args: { file_path: PLAN_PATH, content: 'Plan: do X' } });
  pushLine(child, { type: 'tool_execution_end', toolCallId: 'tc-write', result: { content: [{ type: 'text', text: 'Written.' }] } });
  await Promise.resolve();

  pushLine(child, { type: 'tool_execution_start', toolCallId: 'tc-epm', toolName: 'exit_plan_mode', args: { plan: 'Plan: do X' } });
  await Promise.resolve();

  const collectedEvents: string[] = [];
  const collectLoop = (async () => { for await (const evt of proc.events) { collectedEvents.push(evt.type); if (evt.type === 'turn_complete') break; } })();

  pushLine(child, { type: 'extension_ui_request', id: 'ui-confirm-1', method: 'confirm', title: 'Plan ready for review — approve to proceed with implementation.' });
  await Promise.resolve();
  proc.sendExtensionUiResponse('ui-confirm-1', { confirmed: true });
  pushLine(child, { type: 'tool_execution_end', toolCallId: 'tc-epm', result: { content: [{ type: 'text', text: 'Plan approved.' }] } });
  pushLine(child, { type: 'agent_end', messages: [{ role: 'assistant', content: 'done', usage: { cost: { total: 0.01 } } }] });
  pushLine(child, { type: 'agent_settled' });
  await Promise.resolve();
  await Promise.resolve();

  const result = await turnPromise;
  await collectLoop;
  assert.equal(result.planFilePath, PLAN_PATH);
  assert.equal(result.exitedPlanMode, true);
  child.emit('close', 0);
  await proc.close();
});

// Test F: ask_user_question via extension_ui
test('F: ask_user_question', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k6', sessionId: null, resume: false }) as PIAgentProcess;
  const child = s.children[0];
  await bootstrap(child);
  const turnPromise = proc.send({ text: 'ask me something' });
  pushLine(child, { type: 'tool_execution_start', toolCallId: 'tc-aq', toolName: 'ask_user_question', args: { questions: [{ question: 'What color?' }] } });
  await Promise.resolve();
  pushLine(child, { type: 'extension_ui_request', id: 'ui-sel-1', method: 'select', title: 'What color?', options: ['Red', 'Blue'] });
  await Promise.resolve();
  proc.sendExtensionUiResponse('ui-sel-1', { value: 'Blue' });
  pushLine(child, { type: 'tool_execution_end', toolCallId: 'tc-aq', result: { content: [{ type: 'text', text: 'Blue' }] } });
  pushLine(child, { type: 'agent_end', messages: [] });
  pushLine(child, { type: 'agent_settled' });
  await Promise.resolve();
  const result = await turnPromise;
  assert.equal(result.askUserQuestions, undefined);
  child.emit('close', 0);
  await proc.close();
});

// Test G: fatal error
test('G: fatal error', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k7', sessionId: null, resume: false });
  const child = s.children[0];
  await bootstrap(child);
  const turnPromise = proc.send({ text: 'do something' });
  child.stderr.write('fatal: something broke\n');
  child.emit('close', 1);
  await Promise.resolve();
  await assert.rejects(turnPromise, /fatal|something broke|exited/i);
  await proc.close().catch(() => {});
});

// Test H: clean exit without turn_complete
test('H: clean exit before turn_complete', async () => {
  const s = makeStubSpawner();
  const adapter = new PIAdapter(s.spawn, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'k8', sessionId: null, resume: false });
  const child = s.children[0];
  await bootstrap(child);
  const turnPromise = proc.send({ text: 'do work' });
  child.emit('close', 0);
  await Promise.resolve();
  await assert.rejects(turnPromise, /exited before turn_complete/i);
  await proc.close().catch(() => {});
});

// ─── Tool allowlist gating (thread agents must not get interaction tools) ───

function makeMockPi() {
  const registered: string[] = [];
  const definitions = new Map<string, any>();
  const pi: any = {
    on: () => {},
    registerTool: (def: any) => {
      registered.push(def.name);
      definitions.set(def.name, def);
    },
  };
  return { pi, registered, definitions };
}

function makeCapturingSpawner() {
  const calls: any[] = [];
  const children: any[] = [];
  return {
    calls,
    children,
    spawn: (bin: string, args: string[], opts: any) => {
      calls.push({ bin, args, opts });
      const c = makeStubChild();
      children.push(c);
      return c;
    },
  };
}

const CODER_TOOLS = 'Agent,Bash,Edit,Glob,Grep,Read,Skill,TaskStop,TodoWrite,WebFetch,WebSearch,Write';

test('I: makeToolGate — unset/empty env allows all pseudo-tools', () => {
  for (const env of [undefined, '', '   ']) {
    const gate = makeToolGate(env);
    for (const label of [
      'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'TodoWrite', 'WebFetch', 'WebSearch',
    ]) {
      assert.equal(gate(label), true, `${label} should be allowed when env=${JSON.stringify(env)}`);
    }
  }
});

test('I2: makeToolGate — coder allowlist excludes the three interaction tools', () => {
  const gate = makeToolGate(CODER_TOOLS);
  assert.equal(gate('TodoWrite'), true);
  assert.equal(gate('WebFetch'), true);
  assert.equal(gate('WebSearch'), true);
  assert.equal(gate('AskUserQuestion'), false);
  assert.equal(gate('EnterPlanMode'), false);
  assert.equal(gate('ExitPlanMode'), false);
});

test('I3: makeToolGate — trims surrounding whitespace in entries', () => {
  const gate = makeToolGate(' Bash , TodoWrite ');
  assert.equal(gate('Bash'), true);
  assert.equal(gate('TodoWrite'), true);
  assert.equal(gate('ExitPlanMode'), false);
});

test('J: toolShims registers only allowed tools under a coder allowlist', () => {
  const prev = process.env.CORTEX_PI_ALLOWED_TOOLS;
  process.env.CORTEX_PI_ALLOWED_TOOLS = CODER_TOOLS;
  try {
    const { pi, registered } = makeMockPi();
    toolShims(pi);
    assert.ok(!registered.includes('ask_user_question'), 'ask_user_question must NOT be registered');
    assert.ok(!registered.includes('enter_plan_mode'), 'enter_plan_mode must NOT be registered');
    assert.ok(!registered.includes('exit_plan_mode'), 'exit_plan_mode must NOT be registered');
    assert.ok(registered.includes('todo_write'), 'todo_write must remain registered');
    assert.ok(registered.includes('web_fetch'), 'web_fetch must remain registered');
    assert.ok(registered.includes('web_search'), 'web_search must remain registered');
  } finally {
    if (prev === undefined) delete process.env.CORTEX_PI_ALLOWED_TOOLS;
    else process.env.CORTEX_PI_ALLOWED_TOOLS = prev;
  }
});

test('J2: toolShims registers all shim tools when env is unset', () => {
  const prev = process.env.CORTEX_PI_ALLOWED_TOOLS;
  delete process.env.CORTEX_PI_ALLOWED_TOOLS;
  try {
    const { pi, registered } = makeMockPi();
    toolShims(pi);
    for (const n of [
      'ask_user_question', 'enter_plan_mode', 'exit_plan_mode', 'todo_write', 'web_fetch', 'web_search',
    ]) {
      assert.ok(registered.includes(n), `${n} should be registered when no allowlist is set`);
    }
  } finally {
    if (prev === undefined) delete process.env.CORTEX_PI_ALLOWED_TOOLS;
    else process.env.CORTEX_PI_ALLOWED_TOOLS = prev;
  }
});

test('J3: enter_plan_mode requires writing plan content to the provided file', async () => {
  const prev = process.env.CORTEX_PI_ALLOWED_TOOLS;
  delete process.env.CORTEX_PI_ALLOWED_TOOLS;
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(SESSION_DIR);
  try {
    const { pi, definitions } = makeMockPi();
    toolShims(pi);
    const result = await definitions.get('enter_plan_mode').execute(
      'tc-enter-plan', {}, undefined, undefined, {},
    );
    const output = result.content[0].text;
    assert.match(output, /Plan file: .+plan-\d+\.md/);
    assert.ok(output.includes(
      'IMPORTANT: You MUST write the plan content to the provided plan file before calling ExitPlanMode.',
    ));
  } finally {
    cwdSpy.mockRestore();
    if (prev === undefined) delete process.env.CORTEX_PI_ALLOWED_TOOLS;
    else process.env.CORTEX_PI_ALLOWED_TOOLS = prev;
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

test('K: spawn forwards rawTools allowlist to the subprocess env', async () => {
  const s = makeCapturingSpawner();
  const adapter = new PIAdapter(s.spawn as any, SESSION_DIR);
  const proc = adapter.spawn({ sessionKey: 'kEnv', sessionId: null, resume: false, rawTools: CODER_TOOLS });
  const child = s.children[0];
  await bootstrap(child);
  assert.equal(s.calls[0].opts.env.CORTEX_PI_ALLOWED_TOOLS, CODER_TOOLS);
  child.emit('close', 0);
  await proc.close();
});

test('K2: spawn omits CORTEX_PI_ALLOWED_TOOLS when rawTools is unset', async () => {
  const prev = process.env.CORTEX_PI_ALLOWED_TOOLS;
  delete process.env.CORTEX_PI_ALLOWED_TOOLS;
  try {
    const s = makeCapturingSpawner();
    const adapter = new PIAdapter(s.spawn as any, SESSION_DIR);
    const proc = adapter.spawn({ sessionKey: 'kEnv2', sessionId: null, resume: false });
    const child = s.children[0];
    await bootstrap(child);
    assert.equal(s.calls[0].opts.env.CORTEX_PI_ALLOWED_TOOLS, undefined);
    child.emit('close', 0);
    await proc.close();
  } finally {
    if (prev !== undefined) process.env.CORTEX_PI_ALLOWED_TOOLS = prev;
  }
});

console.error("All tests registered");
