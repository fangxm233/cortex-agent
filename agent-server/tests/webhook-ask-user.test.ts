// input:  createWebhookHandler, hook-bridge, sessionStore
// output: /hook/ask-user-question level validation and sessionId→channel resolution tests
// pos:    Regression guard for the hook-facing ask-user API contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWebhookHandler } from '../src/orchestration/routing/webhook.js';
import { initHookBridge } from '../src/orchestration/routing/hook-bridge.js';
import { EventBus } from '../src/events/event-bus.js';
import type { CortexEvent } from '../src/events/event-types.js';
import { sessionStore } from '../src/store/session-registry-repo.js';

const TOKEN = 'test-webhook-token-ask';
let prevToken: string | undefined;
let handler: ReturnType<typeof createWebhookHandler>;
let bus: EventBus;
let askEvents: Extract<CortexEvent, { type: 'ask-user.requested' }>[];

beforeAll(() => {
  prevToken = process.env.CORTEX_WEBHOOK_TOKEN;
  process.env.CORTEX_WEBHOOK_TOKEN = TOKEN;
  bus = new EventBus();
  initHookBridge(bus);
  askEvents = [];
  bus.subscribe('ask-user.requested', (e) => {
    askEvents.push(e as Extract<CortexEvent, { type: 'ask-user.requested' }>);
  });
  handler = createWebhookHandler();
});
afterAll(() => {
  if (prevToken === undefined) delete process.env.CORTEX_WEBHOOK_TOKEN;
  else process.env.CORTEX_WEBHOOK_TOKEN = prevToken;
});

interface Driven { statusCode: number; body: string }

function drive(body: any): Promise<Driven> {
  return new Promise((resolve) => {
    const req = new EventEmitter() as any;
    req.method = 'POST';
    req.url = '/hook/ask-user-question';
    req.headers = { 'x-cortex-token': TOKEN };
    let statusCode = 200;
    let out = '';
    const res: any = {
      writeHead: (code: number) => { statusCode = code; },
      end: (chunk?: string) => { if (chunk) out += chunk; resolve({ statusCode, body: out }); },
    };
    handler(req, res);
    req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
}

const QUESTIONS = [{ question: 'Go on?', header: 'Gate', options: [], multiSelect: false }];

test("level 'warn' is normalized to 'warning' on the published event", async () => {
  const { statusCode } = await drive({ channel: 'C_LN', sessionId: 's1', questions: QUESTIONS, dryRun: true, level: 'warn' });
  assert.equal(statusCode, 200);
  const ev = askEvents.at(-1)!;
  assert.equal(ev.channel, 'C_LN');
  assert.equal(ev.level, 'warning');
});

test("level 'error' and 'info' pass through unchanged", async () => {
  await drive({ channel: 'C_LE', sessionId: 's1', questions: QUESTIONS, dryRun: true, level: 'error' });
  assert.equal(askEvents.at(-1)!.level, 'error');
  await drive({ channel: 'C_LI', sessionId: 's1', questions: QUESTIONS, dryRun: true, level: 'info' });
  assert.equal(askEvents.at(-1)!.level, 'info');
});

test('an invalid level is rejected with 400 and valid values', async () => {
  const before = askEvents.length;
  const { statusCode, body } = await drive({ channel: 'C_BAD', questions: QUESTIONS, dryRun: true, level: 'fatal' });
  assert.equal(statusCode, 400);
  assert.match(body, /level/);
  assert.match(body, /info.*warn.*error/);
  assert.equal(askEvents.length, before, 'no event published for a rejected request');
});

test('a missing channel is resolved from the session registry via sessionId', async () => {
  await sessionStore.registerSession('cortex-ask1', {
    sessionId: 'sid-ask-resolve',
    channel: 'C_FROM_REGISTRY',
    backend: 'claude',
    kind: 'local',
  });
  const { statusCode } = await drive({ sessionId: 'sid-ask-resolve', questions: QUESTIONS, dryRun: true });
  assert.equal(statusCode, 200);
  assert.equal(askEvents.at(-1)!.channel, 'C_FROM_REGISTRY');
});

test('a missing channel with an unknown sessionId is rejected with 400', async () => {
  const { statusCode, body } = await drive({ sessionId: 'sid-does-not-exist', questions: QUESTIONS, dryRun: true });
  assert.equal(statusCode, 400);
  assert.match(body, /channel/);
});
