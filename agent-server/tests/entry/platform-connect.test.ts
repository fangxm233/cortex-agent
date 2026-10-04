import { test } from 'vitest';
import assert from 'node:assert/strict';
import { startPlatformAdapters } from '../../src/entry/platform-connect.js';
import { CompositeAdapter } from '../../src/platform/adapters/composite-adapter.js';
import { TuiGatewayAdapter } from '../../src/platform/adapters/tui/index.js';
import { MockAdapter } from '../../src/platform/testing.js';
import { setLocale } from '../../src/core/i18n.js';

interface Deferred { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A chat platform whose start() is driven by the test: each call takes the next scripted outcome. */
function fakePlatform(name: string, outcomes: Array<'ok' | Error | Deferred>) {
  const adapter = new MockAdapter({ adminChannel: 'C-admin' });
  Object.defineProperty(adapter, 'name', { value: name });
  const calls: string[] = [];
  adapter.start = async () => {
    calls.push('start');
    const next = outcomes.shift() ?? 'ok';
    if (next === 'ok') return;
    if (next instanceof Error) throw next;
    await next.promise;
  };
  adapter.stop = async () => { calls.push('stop'); };
  return { adapter, calls };
}

function fakeTui() {
  const tui = new TuiGatewayAdapter({ port: 0 });
  let started = false;
  tui.start = async () => { started = true; };
  tui.stop = async () => {};
  return { tui, isStarted: () => started };
}

function never(): never {
  throw new Error('unexpected give-up');
}

test('boot waits for the TUI gateway but not for a chat platform still connecting', async () => {
  const handshake = deferred();
  const slack = fakePlatform('slack', [handshake]);
  const { tui, isStarted } = fakeTui();

  const connections = await startPlatformAdapters(new CompositeAdapter([slack.adapter, tui]), { onGiveUp: never });

  assert.equal(isStarted(), true);
  assert.deepEqual(slack.calls, ['start']);
  let settled = false;
  void connections.settled.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  handshake.resolve();
  await connections.settled;
  assert.deepEqual(slack.calls, ['start']);
});

test('a failed connect is retried after resetting the platform, and stops once it connects', async () => {
  const feishu = fakePlatform('feishu', [new Error('busy'), new Error('busy'), 'ok']);
  const connections = await startPlatformAdapters(feishu.adapter, { retryDelaysMs: [1, 1, 1], onGiveUp: never });
  await connections.settled;
  assert.deepEqual(feishu.calls, ['start', 'stop', 'start', 'stop', 'start']);
});

test('a platform that never connects is reported once after its last attempt', async () => {
  const slack = fakePlatform('slack', [new Error('invalid_auth'), new Error('invalid_auth'), new Error('invalid_auth')]);
  const reports: Array<[string, string]> = [];
  const connections = await startPlatformAdapters(slack.adapter, {
    retryDelaysMs: [1, 1],
    onGiveUp: (platform, error) => { reports.push([platform, error.message]); },
  });
  await connections.settled;
  assert.deepEqual(slack.calls, ['start', 'stop', 'start', 'stop', 'start']);
  assert.deepEqual(reports, [['slack', 'invalid_auth']]);
});

test('the default report is an error notice naming the platform', async () => {
  setLocale('en');
  const slack = fakePlatform('slack', [new Error('invalid_auth')]);
  const connections = await startPlatformAdapters(slack.adapter, { retryDelaysMs: [] });
  await connections.settled;
  await new Promise((resolve) => setImmediate(resolve));
  const notice = slack.adapter.posted.find((post) => post.destination.type === 'system-notice');
  assert.ok(notice, 'expected a system notice');
  assert.match(notice.content.text ?? '', /^Slack failed to connect: invalid_auth\. Cortex won't receive Slack messages until it restarts\.$/);
});

test('stop() during a handshake closes the connection it later produces and never retries', async () => {
  const handshake = deferred();
  const slack = fakePlatform('slack', [handshake]);
  const connections = await startPlatformAdapters(slack.adapter, { retryDelaysMs: [1], onGiveUp: never });

  await connections.stop();
  assert.deepEqual(slack.calls, ['start', 'stop']);

  handshake.resolve();
  await connections.settled;
  assert.deepEqual(slack.calls, ['start', 'stop', 'stop']);
});

test('stop() during a handshake that then fails neither retries nor reports', async () => {
  const handshake = deferred();
  const feishu = fakePlatform('feishu', [handshake]);
  const connections = await startPlatformAdapters(feishu.adapter, { retryDelaysMs: [1], onGiveUp: never });

  await connections.stop();
  handshake.reject(new Error('Feishu adapter stopped'));
  await connections.settled;
  assert.deepEqual(feishu.calls, ['start', 'stop']);
});

test('stop() during the wait before a retry cancels the retry', async () => {
  const slack = fakePlatform('slack', [new Error('busy')]);
  const connections = await startPlatformAdapters(slack.adapter, { retryDelaysMs: [60_000], onGiveUp: never });
  while (!slack.calls.includes('stop')) await new Promise((resolve) => setImmediate(resolve));

  await connections.stop();
  await connections.settled;
  assert.deepEqual(slack.calls, ['start', 'stop', 'stop']);
});
