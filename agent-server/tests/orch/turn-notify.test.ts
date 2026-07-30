// input:  Node test runner + orchestration/turn-notify
// output: isTurnNotifyEnabled / getTurnNotifyThresholdS gating + maybeNotifyTurnComplete dispatch spec
// pos:    turn-completion notification (Slack + Feishu) orchestration unit tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { isTurnNotifyEnabled, getTurnNotifyThresholdS, maybeNotifyTurnComplete } from '../../src/orchestration/turn-notify.js';

type PostCall = { dest: any; content: any; opts: any };

function makeAdapter() {
  const calls: PostCall[] = [];
  const adapter = {
    postMessage: async (dest: any, content: any, opts: any) => {
      calls.push({ dest, content, opts });
      return { conduit: dest.conduit, messageId: 'm1' };
    },
  } as any;
  return { calls, adapter };
}

const base = {
  channel: 'slack:D123',
  threadAnchorId: null,
  sessionName: 'brave-otter',
  sessionId: 's-1',
  elapsedStr: '2m30s',
  metricsSuffix: ' · $0.12',
};

test('isTurnNotifyEnabled: default ON, opt-out via CORTEX_TURN_NOTIFY=0/false/off/no', () => {
  const prev = process.env.CORTEX_TURN_NOTIFY;
  try {
    delete process.env.CORTEX_TURN_NOTIFY;
    assert.equal(isTurnNotifyEnabled(), true, 'enabled by default when unset');
    for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
      process.env.CORTEX_TURN_NOTIFY = off;
      assert.equal(isTurnNotifyEnabled(), false, `disabled by "${off}"`);
    }
    process.env.CORTEX_TURN_NOTIFY = '1';
    assert.equal(isTurnNotifyEnabled(), true, 'explicitly enabled');
    process.env.CORTEX_TURN_NOTIFY = '';
    assert.equal(isTurnNotifyEnabled(), true, 'empty string is not an opt-out');
  } finally {
    if (prev === undefined) delete process.env.CORTEX_TURN_NOTIFY;
    else process.env.CORTEX_TURN_NOTIFY = prev;
  }
});

test('getTurnNotifyThresholdS: default 60, parses int, falls back on invalid', () => {
  const prev = process.env.CORTEX_TURN_NOTIFY_THRESHOLD_S;
  try {
    delete process.env.CORTEX_TURN_NOTIFY_THRESHOLD_S;
    assert.equal(getTurnNotifyThresholdS(), 60, 'default when unset');
    process.env.CORTEX_TURN_NOTIFY_THRESHOLD_S = '30';
    assert.equal(getTurnNotifyThresholdS(), 30);
    process.env.CORTEX_TURN_NOTIFY_THRESHOLD_S = 'abc';
    assert.equal(getTurnNotifyThresholdS(), 60, 'non-numeric falls back');
    process.env.CORTEX_TURN_NOTIFY_THRESHOLD_S = '0';
    assert.equal(getTurnNotifyThresholdS(), 60, 'non-positive falls back');
    process.env.CORTEX_TURN_NOTIFY_THRESHOLD_S = '-5';
    assert.equal(getTurnNotifyThresholdS(), 60, 'negative falls back');
  } finally {
    if (prev === undefined) delete process.env.CORTEX_TURN_NOTIFY_THRESHOLD_S;
    else process.env.CORTEX_TURN_NOTIFY_THRESHOLD_S = prev;
  }
});

test('maybeNotifyTurnComplete: below threshold → no notification', async () => {
  const { calls, adapter } = makeAdapter();
  await maybeNotifyTurnComplete({ adapter, ...base, elapsedS: 10, status: 'completed' });
  assert.equal(calls.length, 0);
});

test('maybeNotifyTurnComplete: at/above threshold → one notification posted', async () => {
  const { calls, adapter } = makeAdapter();
  await maybeNotifyTurnComplete({ adapter, ...base, elapsedS: 120, status: 'completed' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dest.type, 'interactive-reply');
  assert.equal(calls[0].dest.conduit, 'slack:D123');
  assert.match(calls[0].content.text, /2m30s/);
  assert.match(calls[0].content.text, /\$0\.12/);
});

test('maybeNotifyTurnComplete: non-interactive channel (thread/dispatch) → no notification', async () => {
  const { calls, adapter } = makeAdapter();
  await maybeNotifyTurnComplete({ adapter, ...base, channel: 'thread-abc', elapsedS: 999, status: 'completed' });
  assert.equal(calls.length, 0);
});

test('maybeNotifyTurnComplete: disabled via env → no notification', async () => {
  const prev = process.env.CORTEX_TURN_NOTIFY;
  try {
    process.env.CORTEX_TURN_NOTIFY = '0';
    const { calls, adapter } = makeAdapter();
    await maybeNotifyTurnComplete({ adapter, ...base, elapsedS: 999, status: 'completed' });
    assert.equal(calls.length, 0);
  } finally {
    if (prev === undefined) delete process.env.CORTEX_TURN_NOTIFY;
    else process.env.CORTEX_TURN_NOTIFY = prev;
  }
});

test('maybeNotifyTurnComplete: failed status → no metrics in text', async () => {
  const { calls, adapter } = makeAdapter();
  await maybeNotifyTurnComplete({ adapter, ...base, elapsedS: 120, status: 'failed' });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].content.text, /\$0\.12/, 'metrics suffix omitted for failure');
});

test('maybeNotifyTurnComplete: threadAnchorId forwarded as threadId opt', async () => {
  const { calls, adapter } = makeAdapter();
  await maybeNotifyTurnComplete({ adapter, ...base, threadAnchorId: 't-99', elapsedS: 120, status: 'completed' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts, { threadId: 't-99' });
});

test('maybeNotifyTurnComplete: never throws when adapter.postMessage rejects', async () => {
  const adapter = { postMessage: async () => { throw new Error('boom'); } } as any;
  await assert.doesNotReject(maybeNotifyTurnComplete({ adapter, ...base, elapsedS: 120, status: 'completed' }));
});
