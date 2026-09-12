// input:  renderTurnStatus + the locale-resolved status labels
// output: the exact line each turn outcome shows, and the done/awaiting layout asymmetry
// pos:    Pin core/status-format.ts renderTurnStatus — what a user reads in Slack/Feishu
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Icons } from '../../src/core/icons.js';
import { t } from '../../src/core/i18n.js';
import { renderTurnStatus, buildSessionTag } from '../../src/core/status-format.js';

const ctx = { sessionName: 'cortex-abcd', sessionId: 'sess-1', elapsedStr: '3m 4s', metrics: ' · 5 turns · $0.1234' };
const tag = buildSessionTag('cortex-abcd', 'sess-1');

test('done leads with the OUTCOME; every other line leads with the session tag', () => {
  // This inversion is the one thing a naive rewrite of these templates would "tidy away".
  assert.equal(
    renderTurnStatus({ kind: 'done' }, ctx),
    `${Icons.ok} ${t('status.done')} | ${tag}(3m 4s · 5 turns · $0.1234)`,
  );
  assert.equal(
    renderTurnStatus({ kind: 'awaiting-user' }, ctx),
    `${Icons.waiting} ${tag}${t('status.waitingForUserInput')} (3m 4s · 5 turns · $0.1234)`,
  );
  assert.ok(renderTurnStatus({ kind: 'done' }, ctx).indexOf(tag) > 3, 'tag follows the outcome');
  assert.ok(renderTurnStatus({ kind: 'awaiting-user' }, ctx).indexOf(tag) < 4, 'tag leads');
});

test('the background hold shows the remaining count BEFORE the elapsed group', () => {
  assert.equal(
    renderTurnStatus({ kind: 'background-waiting', remaining: 3 }, ctx),
    `${Icons.waiting} ${tag}${t('status.backgroundRunning')} (3) (3m 4s · 5 turns · $0.1234)`,
  );
  assert.equal(
    renderTurnStatus({ kind: 'background-waiting', remaining: 0 }, ctx),
    `${Icons.waiting} ${tag}${t('status.backgroundRunning')} (0) (3m 4s · 5 turns · $0.1234)`,
  );
});

test('the three background seals each carry their own icon and label', () => {
  assert.equal(renderTurnStatus({ kind: 'background-capped' }, ctx),
    `${Icons.waiting} ${tag}${t('status.backgroundStillRunning')} (3m 4s · 5 turns · $0.1234)`);
  assert.equal(renderTurnStatus({ kind: 'background-interrupted' }, ctx),
    `${Icons.warning} ${tag}${t('status.backgroundInterrupted')} (3m 4s · 5 turns · $0.1234)`);
  assert.equal(renderTurnStatus({ kind: 'rate-limited' }, ctx),
    `${Icons.warning} ${tag}${t('status.rateLimitedExhausted')} (3m 4s · 5 turns · $0.1234)`);
});

test('omitted metrics renders the elapsed time alone — the error/cancel paths have none to show', () => {
  const bare = { sessionName: 'cortex-abcd', sessionId: 'sess-1', elapsedStr: '12s' };
  assert.equal(renderTurnStatus({ kind: 'error' }, bare), `${Icons.error} ${tag}${t('status.error')} (12s)`);
  assert.equal(renderTurnStatus({ kind: 'cancelled' }, bare), `${Icons.stopped} ${tag}${t('status.cancelled')} (12s)`);
  assert.equal(renderTurnStatus({ kind: 'superseded' }, bare), `${Icons.superseded} ${tag}${t('status.supersededByEdit')} (12s)`);
  assert.equal(renderTurnStatus({ kind: 'rate-limited' }, bare), `${Icons.warning} ${tag}${t('status.rateLimitedExhausted')} (12s)`);
});

test('an anonymous turn renders without a tag and without a stray separator', () => {
  const anon = { sessionName: null, sessionId: null, elapsedStr: '1s' };
  assert.equal(renderTurnStatus({ kind: 'error' }, anon), `${Icons.error} ${t('status.error')} (1s)`);
  // `done` keeps its own ` | ` — that separator belongs to the outcome, not to the tag.
  assert.equal(renderTurnStatus({ kind: 'done' }, anon), `${Icons.ok} ${t('status.done')} | (1s)`);
});
