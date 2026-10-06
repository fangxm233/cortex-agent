import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerWaitpointTools } from '../../../src/domain/mcp/tools/waitpoint.js';
import { MCP_TOOLS_BY_SERVER } from '../../../src/core/mcp-tool-gate.js';
import { createWebhookHandler } from '../../../src/orchestration/routing/webhook.js';

const TOKEN = 'test-webhook-token-wp';
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

function post(url: string, body: unknown, token: string | null = TOKEN): Promise<{ statusCode: number; json: any }> {
  return new Promise((resolve) => {
    const req = new EventEmitter() as any;
    req.method = 'POST';
    req.url = url;
    req.headers = token ? { 'x-cortex-token': token } : {};
    req.destroy = () => {};
    let statusCode = 200;
    let raw = '';
    const res: any = {
      writeHead: (code: number) => { statusCode = code; },
      end: (chunk?: string) => {
        if (chunk) raw += chunk;
        let json: any = null;
        try { json = JSON.parse(raw); } catch { json = raw; }
        resolve({ statusCode, json });
      },
    };
    handler(req, res);
    req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
}

// ── tool registration ──────────────────────────────────────────

test('the three waitpoint tools register under the names the gate declares', () => {
  const registered: Array<{ name: string; description: string; schema: Record<string, unknown> }> = [];
  const server: any = {
    tool: (name: string, description: string, schema: any, ...rest: any[]) => {
      void rest;
      registered.push({ name, description, schema });
    },
  };
  registerWaitpointTools(server, { webhookBaseUrl: 'http://127.0.0.1:3001', webhookToken: 't' } as any);

  assert.deepEqual(registered.map((t) => t.name), ['wait_create', 'wait_check', 'wait_cancel']);
  for (const { name } of registered) {
    assert.ok(MCP_TOOLS_BY_SERVER['cortex-ext'].includes(name), `${name} must be declared on cortex-ext`);
  }
  // The point of the feature is that the agent ends its turn; the description has to say so.
  assert.match(registered[0].description, /END YOUR TURN/);
  // …but ending the turn is only safe once something will actually signal. Cortex launches and
  // watches nothing, so an agent that arms a waitpoint and walks away without wiring the callback
  // has built a 7-day silence. The description must name the CLI and say the callback is on them.
  assert.match(registered[0].description, /launches nothing and watches nothing/);
  assert.match(registered[0].description, /cortex-signal/);
  assert.ok('intent' in registered[0].schema, 'wait_create must capture an intent for the cold wake');
});

// ── /webhook/waitpoint ─────────────────────────────────────────

test('create → check → cancel round-trips through the agent-side route', async () => {
  const created = await post('/webhook/waitpoint', {
    action: 'create', sessionId: 'sess-tools', channel: 'web:tools-1',
    label: 'arm2', intent: 'the run to finish',
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json.success, true);
  const { id, secret } = created.json.data;
  assert.match(id, /^wp_[0-9a-f]{12}$/);
  assert.equal(typeof secret, 'string');
  assert.equal(created.json.data.state, 'armed');

  const caller = { sessionId: 'sess-tools', channel: 'web:tools-1' };
  const checked = await post('/webhook/waitpoint', { action: 'check', id, ...caller });
  assert.equal(checked.json.data.label, 'arm2');
  assert.equal('secretHash' in checked.json.data, false, 'check must never expose the stored hash');

  const listed = await post('/webhook/waitpoint', { action: 'check', ...caller });
  assert.equal(listed.json.data.waitpoints.some((w: any) => w.id === id), true);

  const cancelled = await post('/webhook/waitpoint', { action: 'cancel', id, ...caller });
  assert.deepEqual(cancelled.json.data, { cancelled: true, state: 'cancelled' });

  // The capability stops working the moment the waitpoint is cancelled.
  const late = await post('/webhook/signal', { id, secret, status: 'ok' }, null);
  assert.equal(late.statusCode, 410);
  assert.equal(late.json.state, 'cancelled');
});

test('create refuses a request it cannot address or describe', async () => {
  const noChannel = await post('/webhook/waitpoint', { action: 'create', sessionId: 'ghost', label: 'x', intent: 'y' });
  assert.equal(noChannel.json.success, false);
  assert.match(noChannel.json.error, /channel/);

  const noIntent = await post('/webhook/waitpoint', { action: 'create', channel: 'web:c', sessionId: 's', label: 'x' });
  assert.equal(noIntent.json.success, false);
  assert.match(noIntent.json.error, /label and intent/);

  const unknown = await post('/webhook/waitpoint', { action: 'teleport' });
  assert.equal(unknown.json.success, false);
  assert.match(unknown.json.error, /unknown action/);
});

test('a signal carrying the issued secret is accepted without the daemon token', async () => {
  const created = await post('/webhook/waitpoint', {
    action: 'create', sessionId: 'sess-tools-2', channel: 'web:tools-2',
    label: 'arm6', intent: 'training', maxSignals: 2,
  });
  const { id, secret } = created.json.data;

  const accepted = await post('/webhook/signal', { id, secret, status: 'ok', message: 'done' }, null);
  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.json.accepted, true);
  assert.equal(accepted.json.fired, true);

  const wrong = await post('/webhook/signal', { id, secret: `${secret}x`, status: 'ok' }, null);
  assert.equal(wrong.statusCode, 401);
});

test('a signal naming an undeclared member is refused with the expected names', async () => {
  const created = await post('/webhook/waitpoint', {
    action: 'create', sessionId: 'sess-tools-3', channel: 'web:tools-3',
    label: 'ladder', intent: 'arms', quorum: { need: 'all', members: ['arm2', 'arm6'] },
  });
  const { id, secret } = created.json.data;

  const typo = await post('/webhook/signal', { id, secret, member: 'arm7', status: 'ok' }, null);
  assert.equal(typo.statusCode, 422);
  assert.equal(typo.json.accepted, false);
  assert.match(typo.json.error, /unknown member "arm7".*arm2, arm6/);

  const anon = await post('/webhook/signal', { id, secret, status: 'ok' }, null);
  assert.equal(anon.statusCode, 422);
  assert.match(anon.json.error, /no member named.*arm2, arm6/);

  const good = await post('/webhook/signal', { id, secret, member: 'arm2', status: 'ok' }, null);
  assert.equal(good.statusCode, 202);
  assert.equal(good.json.fired, false);
});

test('another session can neither inspect nor cancel a waitpoint it does not own', async () => {
  const created = await post('/webhook/waitpoint', {
    action: 'create', sessionId: 'sess-owner', channel: 'web:owner',
    label: 'mine', intent: 'x',
  });
  const { id } = created.json.data;
  const stranger = { sessionId: 'sess-stranger', channel: 'web:stranger' };

  const peek = await post('/webhook/waitpoint', { action: 'check', id, ...stranger });
  assert.equal(peek.json.success, false);
  assert.match(peek.json.error, /belongs to another session/);
  const listed = await post('/webhook/waitpoint', { action: 'check', ...stranger });
  assert.equal(listed.json.data.waitpoints.some((w: any) => w.id === id), false);

  const cancel = await post('/webhook/waitpoint', { action: 'cancel', id, ...stranger });
  assert.equal(cancel.json.success, false);
  const still = await post('/webhook/waitpoint', { action: 'check', id, sessionId: 'sess-owner', channel: 'web:owner' });
  assert.equal(still.json.data.state, 'armed');

  // A later session on the owner's channel receives its wake, so it may manage it.
  const heir = await post('/webhook/waitpoint', { action: 'cancel', id, sessionId: 'sess-heir', channel: 'web:owner' });
  assert.deepEqual(heir.json.data, { cancelled: true, state: 'cancelled' });
});
