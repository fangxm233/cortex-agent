import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  holdNewTurns,
  isRebuildHeld,
  rebuildHold,
  refuseTurnForRebuild,
  releaseNewTurnHold,
  _test as holdTest,
} from '../../../src/domain/system/rebuild-hold.js';
import { handleDaemonMessage } from '../../../src/entry/daemon-notice.js';
import {
  listSystemNotices,
  resetSystemNoticeHistory,
} from '../../../src/domain/system/notice-history.js';
import { MockAdapter } from '../../../src/platform/testing.js';

afterEach(() => {
  holdTest.reset();
  resetSystemNoticeHistory();
});

const T0 = Date.parse('2026-09-21T06:00:00.000Z');

test('a hold keeps the phase it was last told, and its first moment', () => {
  holdNewTurns({ phase: 'server', reason: 'src change: core/foo.ts', now: T0 });
  holdNewTurns({ phase: 'web', reason: 'src change: core/foo.ts', now: T0 + 4_000 });

  const hold = rebuildHold(T0 + 4_100);
  assert.deepEqual(hold, { phase: 'web', reason: 'src change: core/foo.ts', since: T0 });
});

test('the hold expires on its own, so a dead supervisor cannot mute the app forever', () => {
  holdNewTurns({ phase: 'install', reason: 'manual trigger', now: T0 });
  assert.equal(isRebuildHeld(T0 + 60_000), true, 'a minute in, a long install is still plausible');
  assert.equal(isRebuildHeld(T0 + 6 * 60_000), false, 'six minutes of silence means carry on');
});

test('a renewed phase extends the lease from the new message, not the first one', () => {
  holdNewTurns({ phase: 'server', reason: 'r', now: T0 });
  holdNewTurns({ phase: 'web', reason: 'r', now: T0 + 4 * 60_000 });
  assert.equal(isRebuildHeld(T0 + 6 * 60_000), true);
});

test('releasing lifts the hold immediately', () => {
  holdNewTurns({ phase: 'web', reason: 'r', now: T0 });
  releaseNewTurnHold();
  assert.equal(isRebuildHeld(T0), false);
  assert.equal(rebuildHold(T0), null);
});

test('a person who is waiting is answered where they typed, with the phase', async () => {
  const adapter = new MockAdapter();
  holdNewTurns({ phase: 'web', reason: 'src change: core/foo.ts' });

  await refuseTurnForRebuild({ adapter: adapter as any, channel: 'web:s1', text: 'status?', interactive: true });

  assert.equal(adapter.posted.length, 1);
  assert.equal((adapter.posted[0].destination as any).conduit, 'web:s1');
  assert.match(adapter.posted[0].content.text!, /rebuilding/);
  assert.match(adapter.posted[0].content.text!, /web/, 'the phase is named so "wait" has a length');
  assert.equal(listSystemNotices().length, 0, 'no toast on top of an answer they are looking at');
});

test('a callback nobody is reading becomes a notice naming what was dropped', async () => {
  const adapter = new MockAdapter();
  holdNewTurns({ phase: 'restart', reason: 'src rebuild' });

  await refuseTurnForRebuild({
    adapter: adapter as any,
    channel: 'web:s1',
    text: '[Background agent sa_1234 — Implement phase 1]\n\nDone. Here is the report.',
    interactive: false,
  });

  const notices = listSystemNotices();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, 'warning');
  assert.equal(notices[0].title, 'Rebuild');
  assert.match(notices[0].text, /web:s1/);
  assert.match(notices[0].text, /Background agent sa_1234/, 'the dropped message is identifiable');
});

test('the supervisor message sets and clears the hold, and stays out of the notice log', async () => {
  const adapter = new MockAdapter();

  const held = await handleDaemonMessage(
    { type: 'rebuild-hold', hold: true, phase: 'server', reason: 'src change: core/foo.ts' },
    adapter as any,
  );
  assert.equal(held, true, 'handled');
  assert.equal(isRebuildHeld(), true);
  assert.equal(rebuildHold()?.phase, 'server');
  assert.equal(listSystemNotices().length, 0, 'a phase change is not operator news');

  const released = await handleDaemonMessage({ type: 'rebuild-hold', hold: false }, adapter as any);
  assert.equal(released, true);
  assert.equal(isRebuildHeld(), false);
});
