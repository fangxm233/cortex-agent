import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWebhookHandler } from '../src/orchestration/routing/webhook.js';

const TOKEN = 'test-webhook-token-abc';
let prevToken: string | undefined;
let handler: ReturnType<typeof createWebhookHandler>;

beforeAll(() => {
  prevToken = process.env.CORTEX_WEBHOOK_TOKEN;
  process.env.CORTEX_WEBHOOK_TOKEN = TOKEN;
  handler = createWebhookHandler();
});
afterAll(() => {
  if (prevToken === undefined) delete process.env.CORTEX_WEBHOOK_TOKEN;
  else process.env.CORTEX_WEBHOOK_TOKEN = prevToken;
});

interface Driven { statusCode: number; body: string }

/** Drive the handler with a mock req/res. method defaults to GET (no body needed). */
function drive(opts: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: any;
}): Promise<Driven> {
  return new Promise((resolve) => {
    const req = new EventEmitter() as any;
    req.method = opts.method ?? 'GET';
    req.url = opts.url;
    req.headers = opts.headers ?? {};
    let statusCode = 200;
    let body = '';
    const res: any = {
      writeHead: (code: number) => { statusCode = code; },
      end: (chunk?: string) => { if (chunk) body += chunk; resolve({ statusCode, body }); },
    };
    handler(req, res);
    if (opts.method === 'POST') {
      req.emit('data', JSON.stringify(opts.body ?? {}));
      req.emit('end');
    }
  });
}

test('GET /webhook/devices without a token is rejected 401', async () => {
  const { statusCode } = await drive({ url: '/webhook/devices' });
  assert.equal(statusCode, 401);
});

test('GET /webhook/devices with the correct token passes the gate', async () => {
  const { statusCode, body } = await drive({ url: '/webhook/devices', headers: { 'x-cortex-token': TOKEN } });
  assert.equal(statusCode, 200);
  // Devices list shape (no devices online in test) — proves we reached the handler, not the gate.
  assert.deepEqual(JSON.parse(body), { devices: [] });
});

test('POST /hook/ask-user-question without a token is rejected 401', async () => {
  const { statusCode } = await drive({ method: 'POST', url: '/hook/ask-user-question', body: { channel: 'C', questions: [{}] } });
  assert.equal(statusCode, 401);
});

test('an unknown route without a token is rejected 401 (does not leak 404)', async () => {
  const { statusCode } = await drive({ url: '/totally/unknown' });
  assert.equal(statusCode, 401);
});

test('the token exemption covers /webhook/signal and nothing adjacent to it', async () => {
  // Reaching the handler (404 "unknown waitpoint", not 401 "Unauthorized") proves the bearer gate
  // was skipped and the capability check inside the route is what refused the call.
  const signal = await drive({ method: 'POST', url: '/webhook/signal', body: { id: 'wp_nope', secret: 'x' } });
  assert.equal(signal.statusCode, 404);
  assert.equal(JSON.parse(signal.body).accepted, false);

  // Neighbours must stay gated: no prefix matching, no sibling leaking through.
  for (const url of ['/webhook/signals', '/webhook/signal/extra', '/webhook/waitpoint', '/webhook/github']) {
    const { statusCode } = await drive({ method: 'POST', url, body: {} });
    assert.equal(statusCode, 401, `${url} must still require the bearer token`);
  }
});

test('an oversized signal body is refused 413 without being buffered', async () => {
  const result = await new Promise<{ statusCode: number; body: string; destroyed: boolean }>((resolve) => {
    const req = new EventEmitter() as any;
    req.method = 'POST';
    req.url = '/webhook/signal';
    req.headers = {};
    let destroyed = false;
    req.destroy = () => { destroyed = true; };
    let statusCode = 200;
    let body = '';
    const res: any = {
      writeHead: (code: number) => { statusCode = code; },
      end: (chunk?: string) => { if (chunk) body += chunk; resolve({ statusCode, body, destroyed }); },
    };
    handler(req, res);
    req.emit('data', 'x'.repeat(70 * 1024));
    req.emit('end');
  });
  assert.equal(result.statusCode, 413);
  assert.equal(result.destroyed, true, 'the request must be torn down, not read to completion');
});

test('benchmark-only mode serves the benchmark-session route and refuses every other', async () => {
  process.env.CORTEX_WEBHOOK_BENCHMARK_ONLY = '1';
  try {
    for (const url of ['/webhook/remote-command', '/webhook/subagent', '/webhook/team']) {
      const refused = await drive({
        method: 'POST', url, headers: { 'x-cortex-token': TOKEN }, body: { action: 'list' },
      });
      assert.equal(refused.statusCode, 403, url);
    }
    const admitted = await drive({
      method: 'POST', url: '/webhook/benchmark-session',
      headers: { 'x-cortex-token': TOKEN }, body: { action: 'ping' },
    });
    assert.equal(admitted.statusCode, 200);
    assert.deepEqual(JSON.parse(admitted.body), { success: true, data: { ready: true } });
  } finally {
    delete process.env.CORTEX_WEBHOOK_BENCHMARK_ONLY;
  }
});

test('benchmark-only mode still requires the bearer token', async () => {
  process.env.CORTEX_WEBHOOK_BENCHMARK_ONLY = '1';
  try {
    const refused = await drive({
      method: 'POST', url: '/webhook/benchmark-session', headers: {}, body: { action: 'ping' },
    });
    assert.equal(refused.statusCode, 401);
  } finally {
    delete process.env.CORTEX_WEBHOOK_BENCHMARK_ONLY;
  }
});

test('an authorized request to an unknown route gets 404', async () => {
  const { statusCode } = await drive({ method: 'POST', url: '/webhook/github', headers: { 'x-cortex-token': TOKEN }, body: {} });
  assert.equal(statusCode, 404);
});

test('a body that is not JSON gets 400 before any handler runs', async () => {
  const result = await new Promise<{ statusCode: number; body: string }>((resolve) => {
    const req = new EventEmitter() as any;
    req.method = 'POST';
    req.url = '/webhook/remote-command';
    req.headers = { 'x-cortex-token': TOKEN };
    let statusCode = 200;
    const res: any = {
      writeHead: (code: number) => { statusCode = code; },
      end: (chunk?: string) => resolve({ statusCode, body: chunk ?? '' }),
    };
    handler(req, res);
    req.emit('data', '{not json');
    req.emit('end');
  });
  assert.deepEqual(result, { statusCode: 400, body: 'Bad JSON' });
});
