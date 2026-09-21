import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../src/orchestration/agent-runner.js';
import { ThreadExecutor } from '../../src/orchestration/thread-executor.js';
import { holdNewTurns, _test as holdTest } from '../../src/domain/system/rebuild-hold.js';
import { resetSystemNoticeHistory, listSystemNotices } from '../../src/domain/system/notice-history.js';
import { MockAdapter } from '../../src/platform/testing.js';
import { SYNTHETIC_CALLBACK_SENDER } from '../../src/platform/types.js';

// The point of these cases: while the supervisor holds the app, NOTHING may be admitted — not
// tracked (the daemon reads that counter as "busy, defer the restart"), not enqueued, not injected
// into a live turn. A turn started here is orphaned by the SIGTERM a moment later.

afterEach(() => {
  holdTest.reset();
  resetSystemNoticeHistory();
});

let _seq = 0;
function makeCtx(overrides: Record<string, any> = {}) {
  const channel = overrides.channel ?? `rh-test-${++_seq}`;
  return {
    message: {
      ref: { conduit: channel, messageId: 'M1', threadId: null },
      text: 'hi', isBot: false, files: [], senderId: 'U-human',
    } as any,
    channel,
    adapter: new MockAdapter() as any,
    threadAnchorId: null,
    hasFiles: false,
    userMessage: 'hi',
    agentMessage: 'hi',
    ...overrides,
  };
}

function spyRunner() {
  const calls: { track: number[]; enqueued: string[]; injected: number } = { track: [], enqueued: [], injected: 0 };
  const runner = new AgentRunner({
    track: (delta) => calls.track.push(delta),
    enqueue: (channel) => { calls.enqueued.push(channel); return true; },
    execute: async () => {},
    tryInject: async () => { calls.injected += 1; return false; },
  });
  return { runner, calls };
}

test('a held app starts no turn: nothing tracked, queued or injected', async () => {
  const { runner, calls } = spyRunner();
  const ctx = makeCtx();
  holdNewTurns({ phase: 'web', reason: 'src change: core/foo.ts' });

  await runner.route(ctx);

  assert.deepEqual(calls.track, [], 'a tracked turn would tell the daemon to defer its own restart');
  assert.deepEqual(calls.enqueued, []);
  assert.equal(calls.injected, 0, 'not even a fold into a live turn — that turn is about to die too');
  assert.equal(ctx.adapter.posted.length, 1, 'the person is told why');
  assert.match(ctx.adapter.posted[0].content.text!, /rebuilding/);
});

test('with the hold lifted the same message routes normally', async () => {
  const { runner, calls } = spyRunner();
  const ctx = makeCtx();

  await runner.route(ctx);

  assert.deepEqual(calls.track, [1]);
  assert.deepEqual(calls.enqueued, [ctx.channel]);
  assert.equal(ctx.adapter.posted.length, 0);
});

test('a callback refused under the hold is recorded instead of answered into a channel', async () => {
  const { runner, calls } = spyRunner();
  const ctx = makeCtx({
    message: {
      ref: { conduit: 'web:cb', messageId: 'M2', threadId: null },
      text: 'agent done', isBot: false, files: [], senderId: SYNTHETIC_CALLBACK_SENDER,
    } as any,
    channel: 'web:cb',
    userMessage: '[Background agent sa_99 — phase 2]\n\nDone.',
  });
  holdNewTurns({ phase: 'restart', reason: 'src rebuild' });

  await runner.route(ctx);

  assert.deepEqual(calls.track, []);
  assert.equal(ctx.adapter.posted.length, 0, 'no one is reading that channel for this message');
  const notices = listSystemNotices();
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /Background agent sa_99/);
});

test('thread routing is held on the same rule', async () => {
  const track: number[] = [];
  const enqueued: string[] = [];
  const executor = new ThreadExecutor({
    track: (delta) => track.push(delta),
    enqueue: (channel) => { enqueued.push(channel); return true; },
    execute: async () => {},
  });
  const ctx = makeCtx({ threadStartMatch: ['!thread review', 'review'] as any });
  holdNewTurns({ phase: 'install', reason: 'src change: core/foo.ts' });

  await executor.route(ctx as any);

  assert.deepEqual(track, []);
  assert.deepEqual(enqueued, []);
  assert.equal(ctx.adapter.posted.length, 1);
  assert.match(ctx.adapter.posted[0].content.text!, /rebuilding/);
});
