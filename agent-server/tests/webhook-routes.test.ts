import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWebhookHandler } from '../src/orchestration/routing/webhook.js';

const TOKEN = 'test-webhook-routes-token';
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

function post(url: string, body: unknown): Promise<{ statusCode: number; json: any }> {
  return new Promise((resolve) => {
    const req = new EventEmitter() as any;
    req.method = 'POST';
    req.url = url;
    req.headers = { 'x-cortex-token': TOKEN };
    let statusCode = 200;
    const res: any = {
      writeHead: (code: number) => { statusCode = code; },
      end: (chunk?: string) => resolve({ statusCode, json: chunk ? JSON.parse(chunk) : null }),
    };
    handler(req, res);
    req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
}

test('routes reject missing required fields with 400', async () => {
  const cases: Array<[string, unknown]> = [
    ['/webhook/remote-command', { device: 'x' }],
    ['/webhook/remote-fetch', { device: 'x' }],
    ['/webhook/ui-file', { sessionId: 's' }],
    ['/webhook/ui-view', { sessionId: 's' }],
    ['/webhook/ui-decision', { sessionId: 's', decisions: [] }],
    ['/hook/exit-plan-mode', { sessionId: 's' }],
    ['/hook/ask-user-question', { questions: [] }],
  ];
  for (const [url, body] of cases) {
    const { statusCode, json } = await post(url, body);
    assert.equal(statusCode, 400, url);
    assert.ok(json.error, url);
  }
});

test('remote-command to an offline device answers 200 with success:false', async () => {
  const { statusCode, json } = await post('/webhook/remote-command', { device: 'gone', action: 'exec' });
  assert.equal(statusCode, 200);
  assert.equal(json.success, false);
  assert.deepEqual(json.onlineDevices, []);
});

test('waitpoint ops dispatch by action and refuse unknown ones', async () => {
  assert.deepEqual((await post('/webhook/waitpoint', { action: 'nope' })).json, { success: false, error: 'unknown action: nope' });
  assert.deepEqual((await post('/webhook/waitpoint', { action: 'toString' })).json, { success: false, error: 'unknown action: toString' });
  assert.deepEqual((await post('/webhook/waitpoint', { action: 'cancel' })).json, { success: false, error: 'id is required' });
  const listed = await post('/webhook/waitpoint', { action: 'check', sessionId: 'none' });
  assert.deepEqual(listed.json, { success: true, data: { waitpoints: [] } });
});
