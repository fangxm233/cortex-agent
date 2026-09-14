import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { loadThrottleHome } from './throttle-fixture.js';

const home = await loadThrottleHome('runs-notices-test');
const { AttemptNoticeTracker } = await import('../../src/domain/runs/notices.js');

afterAll(() => home.dispose());

const RATE_LIMIT_TEXT = "API Error: Server is temporarily limiting requests (not your usage limit) · This request would exceed your account's rate limit. Please try again later.";

function rateLimitError(): Error {
  return Object.assign(new Error(RATE_LIMIT_TEXT), { rateLimitProvider: 'anthropic' });
}

interface Seen { text: string; level?: string; action?: unknown; subagent?: unknown }

/** A tracker on a web channel for a user-initiated run — the only shape that synthesizes prose. */
function makeTracker(seen: Seen[], ctx: Record<string, unknown> = {}) {
  return new AttemptNoticeTracker(
    { channel: 'web:rate-limit', isUserInitiated: true, ...ctx },
    (text, _blockId, level, action, subagent) => seen.push({ text, level, action, subagent }),
  );
}

test('a held rate-limit card is replaced by the auto-resume warning when the provider is throttled', async (t) => {
  const rl = await home.initThrottle(['plan']);
  t.onTestFinished(() => rl._testReset());

  const seen: Seen[] = [];
  const tracker = makeTracker(seen);

  tracker.observe(RATE_LIMIT_TEXT, undefined, 'error');
  assert.deepEqual(seen, [], 'the card is held until the attempt settles');

  tracker.emitTerminalError(rateLimitError());

  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, 'Rate limited — this chat will resume automatically when the limit resets.');
  assert.equal(seen[0].level, 'warning', 'a paused turn reports the resume promise, not the API error');
});

test('the auto-resume warning carries the cancel-resume action', async (t) => {
  const rl = await home.initThrottle(['plan']);
  t.onTestFinished(() => rl._testReset());

  const seen: Seen[] = [];
  makeTracker(seen).emitTerminalError(rateLimitError());

  assert.equal(seen.length, 1);
  assert.equal(seen[0].level, 'warning');
  assert.deepEqual(seen[0].action, { kind: 'cancel-resume' }, 'the promise is opt-out-able');
});

test('a held rate-limit card is emitted exactly once when the attempt fails terminally', (t) => {
  home.rl._testReset(); // no active throttle — nothing can promise a resume
  t.onTestFinished(() => home.rl._testReset());

  const seen: Seen[] = [];
  const tracker = makeTracker(seen);

  tracker.observe(RATE_LIMIT_TEXT, undefined, 'error');
  tracker.emitTerminalError(rateLimitError());

  assert.deepEqual(seen.map((s) => [s.text, s.level]), [[RATE_LIMIT_TEXT, 'error']]);
});

test('a held card is flushed when the turn recovers and settles successfully', (t) => {
  home.rl._testReset();
  t.onTestFinished(() => home.rl._testReset());

  const seen: Seen[] = [];
  const tracker = makeTracker(seen);

  tracker.observe(RATE_LIMIT_TEXT, undefined, 'error');
  assert.deepEqual(seen, [], 'held while the outcome is unknown');

  tracker.settleSuccess();

  assert.deepEqual(seen.map((s) => [s.text, s.level]), [[RATE_LIMIT_TEXT, 'error']],
    'a turn that recovered from a mid-flight API error still reports it');
});

test('a fallback transition flushes the held card before the fallback warning', (t) => {
  home.rl._testReset();
  t.onTestFinished(() => home.rl._testReset());

  const seen: Seen[] = [];
  const tracker = makeTracker(seen);

  tracker.observe(RATE_LIMIT_TEXT, undefined, 'error');
  tracker.transitionToFallback({ model: 'm1', mode: 'plan' }, { model: 'm2', mode: 'api' });

  assert.deepEqual(seen.map((s) => [s.text, s.level]), [
    [RATE_LIMIT_TEXT, 'error'],
    ['Model fallback: m1/plan → m2/api.', 'warning'],
  ]);
});

test('a fallback opens a fresh dedupe window so the next provider can still report a failure', (t) => {
  home.rl._testReset();
  t.onTestFinished(() => home.rl._testReset());

  const seen: Seen[] = [];
  const tracker = makeTracker(seen);

  tracker.observe('API Error: first provider died', undefined, 'error');
  tracker.transitionToFallback({ model: 'm1', mode: 'plan' }, { model: 'm2', mode: 'api' });
  seen.length = 0;

  tracker.emitTerminalError(new Error('API Error: second provider died too'));

  assert.deepEqual(seen.map((s) => [s.text, s.level]), [['API Error: second provider died too', 'error']],
    "the new provider's failure is not hidden by the old provider's notice");
});

test('the notice path forwards native-subagent attribution', () => {
  // This sits on EVERY assistant message while tool calls bypass it. When it took only four
  // parameters it silently swallowed the fifth, so a subagent's prose reached the transcript
  // untagged and leaked into the main stream while that same subagent's tool rows stayed grouped.
  const seen: Seen[] = [];
  const tracker = makeTracker(seen, { channel: 'web:subagent' });

  const subagent = { parentToolUseId: 'toolu_01abc', type: 'Explore', description: 'Survey the repo' };
  tracker.observe('subagent notes', undefined, undefined, undefined, subagent);
  tracker.observe('main agent answer');

  assert.deepEqual(seen.map((s) => [s.text, s.subagent]), [
    ['subagent notes', subagent],
    ['main agent answer', undefined],
  ]);
});

test('a non-web run gets no synthesized prose, only the backend’s own lines', (t) => {
  home.rl._testReset();
  t.onTestFinished(() => home.rl._testReset());

  const seen: Seen[] = [];
  const tracker = new AttemptNoticeTracker(
    { channel: 'slack:C123', isUserInitiated: true },
    (text, _b, level) => seen.push({ text, level }),
  );

  // Slack/Feishu render a status message instead; a synthesized card would duplicate it.
  tracker.observe(RATE_LIMIT_TEXT, undefined, 'error');
  tracker.emitTerminalError(rateLimitError());

  assert.deepEqual(seen.map((s) => [s.text, s.level]), [[RATE_LIMIT_TEXT, 'error']],
    'the backend line passes through untouched and nothing is added');
});
