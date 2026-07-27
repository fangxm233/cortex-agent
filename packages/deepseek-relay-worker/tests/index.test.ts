// input:  Worker handler, Fetch API requests, fake upstream fetch
// output: relay authentication, allowlist, streaming, and failure tests
// pos:    DeepSeek relay Worker security and forwarding regressions
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  MAX_REQUEST_BYTES,
  handleRequest,
  type RelayEnv,
  type UpstreamFetch,
} from '../src/index.js';

const ENV: RelayEnv = {
  RELAY_TOKEN: 'relay-secret',
  DEEPSEEK_API_KEY: 'upstream-secret',
};

function relayRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('authorization', 'Bearer relay-secret');
  return new Request(`https://relay.example${path}`, { ...init, headers });
}

function failIfFetched(): UpstreamFetch {
  return async () => {
    throw new Error('upstream fetch must not be called');
  };
}

test('health is public and never contacts the upstream', async () => {
  const response = await handleRequest(
    new Request('https://relay.example/health'),
    ENV,
    failIfFetched(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('missing or wrong relay token returns 401 without upstream access', async () => {
  for (const authorization of [undefined, 'Bearer wrong', 'Basic relay-secret']) {
    const headers = authorization ? { authorization } : undefined;
    const response = await handleRequest(
      new Request('https://relay.example/chat/completions', { method: 'POST', headers }),
      ENV,
      failIfFetched(),
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  }
});

test('method and path allowlists reject requests before upstream access', async () => {
  const wrongMethod = await handleRequest(
    relayRequest('/chat/completions', { method: 'GET' }),
    ENV,
    failIfFetched(),
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');

  const wrongPath = await handleRequest(
    relayRequest('/proxy/https://example.com', { method: 'POST' }),
    ENV,
    failIfFetched(),
  );
  assert.equal(wrongPath.status, 404);
});

test('chat forwarding fixes the upstream and replaces sensitive headers', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const upstream: UpstreamFetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response('ok', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const request = relayRequest('/v1/chat/completions?trace=1', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      cookie: 'private=cookie',
      'cf-connecting-ip': '192.0.2.1',
      'x-client-secret': 'do-not-forward',
    },
    body: JSON.stringify({ model: 'deepseek-chat', stream: true }),
  });

  const response = await handleRequest(request, ENV, upstream);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions?trace=1');
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('authorization'), 'Bearer upstream-secret');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('accept'), 'text/event-stream');
  assert.equal(headers.get('cookie'), null);
  assert.equal(headers.get('cf-connecting-ip'), null);
  assert.equal(headers.get('x-client-secret'), null);
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(calls[0].init.body as ArrayBuffer)),
    { model: 'deepseek-chat', stream: true },
  );
});

test('models GET is forwarded with relay query parameters intact', async () => {
  let upstreamUrl = '';
  const upstream: UpstreamFetch = async (input) => {
    upstreamUrl = String(input);
    return Response.json({ data: [] });
  };
  const response = await handleRequest(relayRequest('/models?limit=1'), ENV, upstream);
  assert.equal(response.status, 200);
  assert.equal(upstreamUrl, 'https://api.deepseek.com/models?limit=1');
});

test('Worker runtime execution context is not mistaken for the upstream fetch function', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
  const runtimeFetch = worker.fetch as unknown as (
    request: Request,
    env: RelayEnv,
    context: unknown,
  ) => Promise<Response>;

  const response = await runtimeFetch(relayRequest('/models'), ENV, { waitUntil() {} });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [] });
});

test('request bodies above the hard limit return 413', async () => {
  const body = new Uint8Array(MAX_REQUEST_BYTES + 1);
  const response = await handleRequest(
    relayRequest('/chat/completions', { method: 'POST', body }),
    ENV,
    failIfFetched(),
  );
  assert.equal(response.status, 413);
});

test('upstream status, streaming body, and safe response headers pass through', async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: first\n\n'));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  const upstream: UpstreamFetch = async () => new Response(source, {
    status: 429,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'retry-after': '2',
      'x-request-id': 'request-1',
      'x-ratelimit-remaining': '0',
      'set-cookie': 'secret=cookie',
    },
  });

  const response = await handleRequest(
    relayRequest('/chat/completions', { method: 'POST', body: '{}' }),
    ENV,
    upstream,
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('retry-after'), '2');
  assert.equal(response.headers.get('x-request-id'), 'request-1');
  assert.equal(response.headers.get('x-ratelimit-remaining'), '0');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await response.text(), 'data: first\n\ndata: [DONE]\n\n');
});

test('upstream fetch exceptions log route metadata but return a generic 502', async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  const response = await handleRequest(
    relayRequest('/chat/completions', { method: 'POST', body: '{}' }),
    ENV,
    async () => { throw new Error('network connection lost'); },
  );
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /upstream unavailable/i);
  assert.ok(!text.includes('upstream-secret'));
  assert.ok(!text.includes('relay-secret'));
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'DeepSeek upstream fetch failed (POST /chat/completions):');
  assert.match(String(logs[0][1]), /network connection lost/);
});
