// input:  Node test runner + webhook createWebhookHandler auth gate
// output: token-gate tests (401 without/with wrong token; pass with token; github exempt)
// pos:    Regression guard for the webhook HTTP bearer-token gate (no-Cloudflare auth model)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
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

test('GET /webhook/devices with a wrong token is rejected 401', async () => {
  const { statusCode } = await drive({ url: '/webhook/devices', headers: { 'x-cortex-token': 'nope' } });
  assert.equal(statusCode, 401);
});

test('GET /webhook/devices with the correct token passes the gate', async () => {
  const { statusCode, body } = await drive({ url: '/webhook/devices', headers: { 'x-cortex-token': TOKEN } });
  assert.equal(statusCode, 200);
  // Devices list shape (no devices online in test) — proves we reached the handler, not the gate.
  assert.deepEqual(JSON.parse(body), { devices: [] });
});

test('POST /webhook/remote-command without a token is rejected 401', async () => {
  const { statusCode } = await drive({ method: 'POST', url: '/webhook/remote-command', body: { device: 'x', action: 'bash' } });
  assert.equal(statusCode, 401);
});

test('POST /webhook/thread-op without a token is rejected 401', async () => {
  const { statusCode } = await drive({ method: 'POST', url: '/webhook/thread-op', body: { action: 'list' } });
  assert.equal(statusCode, 401);
});

test('POST /hook/ask-user-question without a token is rejected 401', async () => {
  const { statusCode } = await drive({ method: 'POST', url: '/hook/ask-user-question', body: { channel: 'C', questions: [{}] } });
  assert.equal(statusCode, 401);
});

test('an unknown route without a token is rejected 401 (does not leak 404)', async () => {
  const { statusCode } = await drive({ url: '/totally/unknown' });
  assert.equal(statusCode, 401);
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
