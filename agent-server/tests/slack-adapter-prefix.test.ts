// input:  SlackAdapter, isolated config, mocked Slack client
// output: conduit, persistence, and nullable hot-routing regressions
// pos:    Verifies Slack adapter platform boundaries
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SlackAdapter } from '../src/platform/adapters/slack.js';
import { CONFIG_DIR } from '../src/core/paths.js';
import { shouldWarnReactionFailure } from '../src/platform/utils/reaction-diagnostics.js';
import type { ActionContext, MessageContext } from '../src/platform/types.js';

/** Build a SlackAdapter without invoking the real constructor (no Bolt App). */
function makeAdapter(): any {
  const a = Object.create(SlackAdapter.prototype) as any;
  a.config = { botToken: 'xoxb-test', signingSecret: 'sig', appToken: 'xapp-test' };
  a.pendingEdits = new Map();
  a._adminAutoDetected = false;
  return a;
}

// ── resolveDestination: project-report DM fallback ────────────────

test('SlackAdapter.resolveDestination: project-report uses bound conduit', async () => {
  const a = makeAdapter();
  a._conduitsStore = { get: async (id: string) => (id === 'proj1' ? 'C_bound' : null) };
  const r = await a.resolveDestination({ type: 'project-report', projectId: 'proj1', trigger: 't' });
  assert.deepEqual(r, { channel: 'C_bound', kind: 'project-report' });
});

test('SlackAdapter.resolveDestination: unbound project-report falls back to admin DM when configured', async () => {
  const a = makeAdapter();
  a._conduitsStore = { get: async () => null };
  a.config.adminChannel = 'C_admin';
  const r = await a.resolveDestination({ type: 'project-report', projectId: 'missing', trigger: 't' });
  assert.equal(r.channel, 'C_admin');
  assert.equal(r.kind, 'project-report-dm');
});

test('SlackAdapter.resolveDestination: unbound project-report dropped when no admin channel', async () => {
  const a = makeAdapter();
  a._conduitsStore = { get: async () => null };
  // config.adminChannel is undefined (makeAdapter sets only tokens)
  const r = await a.resolveDestination({ type: 'project-report', projectId: 'missing', trigger: 't' });
  assert.equal(r.channel, null);
  assert.equal(r.kind, 'project-report-noop');
});

// ── ownsConduit ───────────────────────────────────────────────────

test('SlackAdapter.ownsConduit: only matches slack: prefix', () => {
  const a = makeAdapter();
  assert.equal(a.ownsConduit('slack:C1'), true);
  assert.equal(a.ownsConduit('feishu:oc_1'), false);
  assert.equal(a.ownsConduit('tui-abc'), false);
  assert.equal(a.ownsConduit('C1'), false);
});

// ── postMessage returns a prefixed conduit; SDK sees the bare channel ──

test('SlackAdapter.postMessage: wraps returned conduit, calls SDK with bare channel', async () => {
  const a = makeAdapter();
  let sentChannel: string | undefined;
  a.rateLimiter = { acquire: async () => {}, reportThrottled: () => {} };
  a.client = {
    chat: {
      postMessage: async (payload: any) => { sentChannel = payload.channel; return { ts: '111' }; },
    },
  };
  const ref = await a.postMessage(
    { type: 'interactive-reply', conduit: 'slack:C123', sessionId: '' },
    { text: 'hi' },
  );
  assert.equal(sentChannel, 'C123');           // SDK gets the bare channel
  assert.equal(ref.conduit, 'slack:C123');     // returned ref is prefixed
  assert.equal(ref.messageId, '111');
});

// ── inbound onMessage produces a prefixed conduit + file conduit ──

test('SlackAdapter.onMessage: inbound ref + files carry slack: prefix', async () => {
  const a = makeAdapter();
  let registeredCb: ((args: { event: any; client: any }) => Promise<void>) | null = null;
  a.app = { event: (_e: string, cb: any) => { registeredCb = cb; } };
  const captured: MessageContext[] = [];
  a.onMessage(async (ctx: MessageContext) => { captured.push(ctx); });

  await registeredCb!({
    event: {
      type: 'message', channel: 'C9', ts: '222', user: 'U1', text: 'yo',
      files: [{ id: 'F1', name: 'a.pdf', mimetype: 'application/pdf', url_private: 'u' }],
    },
    client: {},
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].message.ref.conduit, 'slack:C9');
  assert.equal(captured[0].message.files?.[0].conduit, 'slack:C9');
});

test('SlackAdapter admin auto-detect persists settings without mutating process env', async () => {
  const previous = process.env.CORTEX_ADMIN_CHANNEL;
  delete process.env.CORTEX_ADMIN_CHANNEL;
  try {
    const a = makeAdapter();
    let registeredCb: ((args: { event: any; client: any }) => Promise<void>) | null = null;
    let persisted: string | null = null;
    let noticeText: string | null = null;
    a.app = { event: (_e: string, cb: any) => { registeredCb = cb; } };
    a._persistAdminChannel = async (channel: string) => { persisted = channel; };
    a.postMessage = async (_dest: any, content: any) => {
      noticeText = content.text;
      return { conduit: '', messageId: '' };
    };
    a.onMessage(async () => {});

    await registeredCb!({
      event: { type: 'message', channel: 'D_admin', ts: '223', user: 'U1', text: 'hello' },
      client: {},
    });

    assert.equal(a.config.adminChannel, 'D_admin');
    assert.equal(persisted, 'D_admin');
    assert.equal(process.env.CORTEX_ADMIN_CHANNEL, undefined);
    assert.match(noticeText!, /settings\.json/);
    assert.doesNotMatch(noticeText!, /\.env/);
  } finally {
    if (previous === undefined) delete process.env.CORTEX_ADMIN_CHANNEL;
    else process.env.CORTEX_ADMIN_CHANNEL = previous;
  }
});

test('SlackAdapter persists a detected admin channel only to settings.json', async () => {
  const envPath = path.join(CONFIG_DIR, '.env');
  const settingsPath = path.join(CONFIG_DIR, 'settings.json');
  const sentinel = 'SLACK_BOT_TOKEN=keep-me\n';
  await fs.writeFile(envPath, sentinel);

  const a = makeAdapter();
  await a._persistAdminChannel('D_settings');

  const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  assert.equal(settings.adminChannel, 'D_settings');
  assert.equal(await fs.readFile(envPath, 'utf8'), sentinel);
});

test('SlackAdapter setAdminChannel routes subsequent notices to the new channel', async () => {
  const a = makeAdapter();
  a.config.adminChannel = 'D_old';
  a.rateLimiter = { acquire: async () => {}, reportThrottled: () => {} };
  let sentChannel: string | null = null;
  a.client = {
    chat: {
      postMessage: async (payload: any) => {
        sentChannel = payload.channel;
        return { ts: '224' };
      },
    },
  };

  a.setAdminChannel('D_new');
  await a.postMessage({ type: 'system-notice' }, { text: 'updated' });

  assert.equal(sentChannel, 'D_new');
});

test('SlackAdapter setAdminChannel null drops subsequent notices', async () => {
  const a = makeAdapter();
  a.config.adminChannel = 'D_old';
  let postCalls = 0;
  a.client = { chat: { postMessage: async () => { postCalls++; } } };

  a.setAdminChannel(null);
  const ref = await a.postMessage({ type: 'system-notice' }, { text: 'cleared' });

  assert.deepEqual(ref, { conduit: '', messageId: '' });
  assert.equal(postCalls, 0);
});

// ── onAction wraps channelId / messageRef.conduit / triggerId ──

test('SlackAdapter.onAction: channelId, messageRef.conduit and triggerId are prefixed', async () => {
  const a = makeAdapter();
  let registered: ((args: any) => Promise<void>) | null = null;
  a.app = { action: (_id: string, cb: any) => { registered = cb; } };
  let ctx: ActionContext | null = null;
  a.onAction('btn', async (c: ActionContext) => { ctx = c; });

  await registered!({
    ack: async () => {},
    action: { value: 'v' },
    body: { trigger_id: 'tg', channel: { id: 'C7' }, message: { ts: '333' }, user: { id: 'U2' } },
  });

  assert.ok(ctx);
  assert.equal(ctx!.channelId, 'slack:C7');
  assert.equal(ctx!.messageRef?.conduit, 'slack:C7');
  assert.equal(ctx!.triggerId, 'slack:tg');
});

// ── queue marker lifecycle uses one symmetric Slack reaction ──────

test('SlackAdapter queue marker turns the hourglass into a check once consumed', async () => {
  const a = makeAdapter();
  const calls: Array<{ op: string; payload: any }> = [];
  a.rateLimiter = { acquire: async () => {}, reportThrottled: () => {} };
  a.client = {
    reactions: {
      add: async (payload: any) => { calls.push({ op: 'add', payload }); },
      remove: async (payload: any) => { calls.push({ op: 'remove', payload }); },
    },
  };
  const ref = { conduit: 'slack:C55', messageId: '171.22' };

  await a.markQueued(ref);
  await a.unmarkQueued(ref);

  assert.deepEqual(calls, [
    { op: 'add', payload: { channel: 'C55', name: 'hourglass', timestamp: '171.22' } },
    { op: 'remove', payload: { channel: 'C55', name: 'hourglass', timestamp: '171.22' } },
    { op: 'add', payload: { channel: 'C55', name: 'white_check_mark', timestamp: '171.22' } },
  ]);
});

test('SlackAdapter still records the consumed check when the hourglass removal fails', async () => {
  const a = makeAdapter();
  const added: string[] = [];
  a.rateLimiter = { acquire: async () => {}, reportThrottled: () => {} };
  a.client = {
    reactions: {
      add: async (payload: any) => { added.push(payload.name); },
      remove: async () => { throw Object.assign(new Error('no_reaction'), { data: { error: 'no_reaction' } }); },
    },
  };

  await assert.rejects(a.unmarkQueued({ conduit: 'slack:C55', messageId: '171.22' }), /no_reaction/);
  assert.deepEqual(added, ['white_check_mark'], 'a stale hourglass must not cost the check');
});

test('SlackAdapter queue marker failure propagates instead of being hidden in the adapter', async () => {
  const a = makeAdapter();
  a.rateLimiter = { acquire: async () => {}, reportThrottled: () => {} };
  a.client = {
    reactions: {
      add: async () => { throw Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } }); },
      remove: async () => { throw Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } }); },
    },
  };
  const ref = { conduit: 'slack:C55', messageId: '171.22' };

  await assert.rejects(a.markQueued(ref), /missing_scope/);
  await assert.rejects(a.unmarkQueued(ref), /missing_scope/);
});

test('reaction failure warning fires once per distinct reason', () => {
  const seen = new Set<string>();
  assert.equal(shouldWarnReactionFailure('missing_scope', seen), true);
  assert.equal(shouldWarnReactionFailure('missing_scope', seen), false, 'no per-message log spam');
  assert.equal(shouldWarnReactionFailure('already_reacted', seen), true, 'a new reason is still reported');
});

// ── project conduit registry: store stays bare, surface is prefixed ──

test('SlackAdapter project conduits: store bare, expose prefixed, resolve unwraps', async () => {
  const a = makeAdapter();
  const backing: Record<string, string> = {};
  a._conduitsStore = {
    set: async (p: string, ch: string) => { backing[p] = ch; },
    remove: async (p: string) => { delete backing[p]; },
    get: async (p: string) => backing[p] ?? null,
    getAll: async () => ({ ...backing }),
  };

  // bindProjectConduit strips the prefix before persisting
  await a.bindProjectConduit('proj1', 'slack:C500');
  assert.equal(backing.proj1, 'C500');

  // getProjectConduits exposes the prefixed form
  const all = await a.getProjectConduits();
  assert.equal(all.proj1, 'slack:C500');

  // resolveInboundProject accepts a prefixed conduit and matches the bare store
  assert.equal(await a.resolveInboundProject('slack:C500'), 'proj1');
  assert.equal(await a.resolveInboundProject('slack:C999'), null);
});
