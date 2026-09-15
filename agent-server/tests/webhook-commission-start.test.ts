// input:  POST /hook/commission-start with a real (isolated) session registry
// output: the agent's entry into commission mode — draft dir + registry flag + one live event,
//         idempotent on repeat, refused for a bound session and while the feature is off
// pos:    guards the loopback the cortex_commission_start MCP tool calls (DR-0037 v4)
import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { createWebhookHandler } from '../src/orchestration/routing/webhook.js';
import { initHookBridge } from '../src/orchestration/routing/hook-bridge.js';
import { setOrchestrationRuntime } from '../src/orchestration/runtime.js';
import { EventBus } from '../src/events/event-bus.js';
import type { CortexEvent } from '../src/events/event-types.js';
import { sessionStore } from '../src/store/session-registry-repo.js';
import { projectStore } from '../src/domain/projects/project-store.js';
import { commissionsRoot } from '../src/domain/commissions/commission-paths.js';
import { resetSettingsForTests } from '../src/core/settings.js';

const TOKEN = 'test-webhook-token-commission';
let prevToken: string | undefined;
let handler: ReturnType<typeof createWebhookHandler>;
let events: Extract<CortexEvent, { type: 'session.commission' }>[];

// The store cached its scan before this test home existed; `general` is synthesized by the rescan.
projectStore.refresh();
const PROJECT = projectStore.getDefault().id;

beforeAll(() => {
  prevToken = process.env.CORTEX_WEBHOOK_TOKEN;
  process.env.CORTEX_WEBHOOK_TOKEN = TOKEN;
  process.env.CORTEX_COMMISSION_ENABLED = '1';
  resetSettingsForTests();
  const bus = new EventBus();
  initHookBridge(bus);
  // publishSessionCommission reaches for the orchestration runtime's bus, the way a webhook
  // running hours after boot has to.
  setOrchestrationRuntime({ bus });
  events = [];
  bus.subscribe('session.commission', (e) => {
    events.push(e as Extract<CortexEvent, { type: 'session.commission' }>);
  });
  handler = createWebhookHandler();
});
afterAll(() => {
  if (prevToken === undefined) delete process.env.CORTEX_WEBHOOK_TOKEN;
  else process.env.CORTEX_WEBHOOK_TOKEN = prevToken;
  delete process.env.CORTEX_COMMISSION_ENABLED;
  resetSettingsForTests();
});

function drive(body: any): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve) => {
    const req = new EventEmitter() as any;
    req.method = 'POST';
    req.url = '/hook/commission-start';
    req.headers = { 'x-cortex-token': TOKEN };
    let statusCode = 200;
    let out = '';
    const res: any = {
      writeHead: (code: number) => { statusCode = code; },
      end: (chunk?: string) => {
        if (chunk) out += chunk;
        resolve({ statusCode, body: out ? JSON.parse(out) : null });
      },
    };
    handler(req, res);
    req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
}

let seq = 0;
async function liveSession(fields: { commissionId?: string | null } = {}) {
  seq += 1;
  const name = `cortex-hook${seq}`;
  const sessionId = `sess-hook${seq}`;
  await sessionStore.registerSession(name, {
    sessionId, channel: `web:${sessionId}`, backend: 'claude', kind: 'local', projectId: PROJECT,
    commissionId: fields.commissionId ?? null,
  });
  return { name, sessionId, channel: `web:${sessionId}` };
}

test('an ordinary session can put itself into the drafting phase', async () => {
  const s = await liveSession();
  const res = await drive({ sessionId: s.sessionId, channel: s.channel });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.draftDir, `_draft-${s.name}`);
  assert.equal(res.body.alreadyDrafting, false);
  assert.equal(res.body.dir, path.join(commissionsRoot(PROJECT)!, `_draft-${s.name}`));
  assert.ok(fs.existsSync(res.body.dir), 'the tool reports a directory that exists');
  assert.equal((await sessionStore.getById(s.sessionId))?.commissionDraft, `_draft-${s.name}`);
  assert.deepEqual(events.at(-1), { type: 'session.commission', sessionId: s.sessionId, channel: s.channel, ts: events.at(-1)!.ts });
});

test('calling it again is idempotent and publishes nothing new', async () => {
  const s = await liveSession();
  await drive({ sessionId: s.sessionId, channel: s.channel });
  const before = events.length;
  const again = await drive({ sessionId: s.sessionId, channel: s.channel });

  assert.equal(again.body.ok, true);
  assert.equal(again.body.alreadyDrafting, true, 'so the tool can say "already drafting" instead of restarting');
  assert.equal(again.body.draftDir, `_draft-${s.name}`, 'the same directory — nothing drilled so far is lost');
  assert.equal(events.length, before, 'the capsule was already lit');
});

test('a bound session is refused: one commission per session', async () => {
  const s = await liveSession({ commissionId: 'c-old' });
  const res = await drive({ sessionId: s.sessionId, channel: s.channel });

  assert.equal(res.statusCode, 200, 'a refusal is a tool-level answer, not a transport failure');
  assert.match(res.body.error, /already bound to commission c-old/);
  assert.equal(res.body.ok, undefined);
});

test('an unknown or absent session id creates nothing', async () => {
  const ghost = await drive({ sessionId: 'nope', channel: 'web:nope' });
  assert.match(ghost.body.error, /unknown session nope/);

  const anonymous = await drive({ channel: 'web:x' });
  assert.match(anonymous.body.error, /requires CORTEX_SESSION_ID/);
});

test('the kill switch bites here too, since this is now the way in', async () => {
  const s = await liveSession();
  process.env.CORTEX_COMMISSION_ENABLED = '0';
  resetSettingsForTests();
  try {
    const res = await drive({ sessionId: s.sessionId, channel: s.channel });
    assert.match(res.body.error, /disabled on this server/);
    assert.equal((await sessionStore.getById(s.sessionId))?.commissionDraft, null);
  } finally {
    process.env.CORTEX_COMMISSION_ENABLED = '1';
    resetSettingsForTests();
  }
});
