import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWebhookHandler } from '../src/orchestration/routing/webhook.js';

const TOKEN = 'test-webhook-token-abc';
let prevToken: string | undefined;
let prevGithub: string | undefined;
// Built in beforeAll() so getSecret() default captures the cleared github secret.
let handler: ReturnType<typeof createWebhookHandler>;

beforeAll(() => {
  prevToken = process.env.CORTEX_WEBHOOK_TOKEN;
  process.env.CORTEX_WEBHOOK_TOKEN = TOKEN;
  // Clear the GitHub HMAC secret so the github-exemption test can prove the token gate
  // (not HMAC) is what's being bypassed: with no secret, verifySignature passes.
  prevGithub = process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;
  handler = createWebhookHandler();
});
afterAll(() => {
  if (prevToken === undefined) delete process.env.CORTEX_WEBHOOK_TOKEN;
  else process.env.CORTEX_WEBHOOK_TOKEN = prevToken;
  if (prevGithub === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
  else process.env.GITHUB_WEBHOOK_SECRET = prevGithub;
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
  for (const url of ['/webhook/signals', '/webhook/signal/extra', '/webhook/waitpoint', '/webhook/task-op']) {
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

test('POST /webhook/github is exempt from the token gate (uses HMAC instead)', async () => {
  // No x-cortex-token header. With no GITHUB_WEBHOOK_SECRET configured, verifySignature
  // returns true (warns) and a non-push event is Ignored with 200 — proving the token
  // gate did NOT intercept the github route.
  const { statusCode, body } = await drive({
    method: 'POST',
    url: '/webhook/github',
    headers: { 'x-github-event': 'ping' },
    body: {},
  });
  assert.equal(statusCode, 200);
  assert.equal(body, 'Ignored');
});
