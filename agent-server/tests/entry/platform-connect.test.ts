import { test } from 'vitest';
import assert from 'node:assert/strict';
import { startPlatformAdapters } from '../../src/entry/platform-connect.js';
import { CompositeAdapter } from '../../src/platform/adapters/composite-adapter.js';
import { TuiGatewayAdapter } from '../../src/platform/adapters/tui/index.js';
import { MockAdapter } from '../../src/platform/testing.js';
import { setLocale } from '../../src/core/i18n.js';
import type { SystemNoticeInput } from '../../src/domain/system/system-notice.js';

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

function never(notice: SystemNoticeInput): never {
  throw new Error(`unexpected notice: ${notice.text}`);
}

test('boot waits for the TUI gateway but not for a chat platform still connecting', async () => {
  const handshake = deferred();
  const slack = fakePlatform('slack', [handshake]);
  const { tui, isStarted } = fakeTui();

  const connections = await startPlatformAdapters(new CompositeAdapter([slack.adapter, tui]), { notify: never });

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
  const connections = await startPlatformAdapters(feishu.adapter, { retryDelaysMs: [1, 1, 1], notify: never });
  await connections.settled;
  assert.deepEqual(feishu.calls, ['start', 'stop', 'start', 'stop', 'start']);
});

test('a platform that never connects is reported once, as an error, after its last attempt', async () => {
  setLocale('en');
  const slack = fakePlatform('slack', [new Error('invalid_auth'), new Error('invalid_auth'), new Error('invalid_auth')]);
  const notices: SystemNoticeInput[] = [];
  const connections = await startPlatformAdapters(slack.adapter, {
    retryDelaysMs: [1, 1],
    notify: (notice) => { notices.push(notice); },
  });
  await connections.settled;
  assert.deepEqual(slack.calls, ['start', 'stop', 'start', 'stop', 'start']);
  assert.deepEqual(notices, [{
    level: 'error',
    title: 'Slack',
    text: "Slack failed to connect: invalid_auth. Cortex won't receive Slack messages until it restarts.",
  }]);
});

test('by default the report goes out as a system notice through the adapter', async () => {
  setLocale('en');
  const feishu = fakePlatform('feishu', [new Error('bad app')]);
  const connections = await startPlatformAdapters(feishu.adapter, { retryDelaysMs: [] });
  await connections.settled;
  await new Promise((resolve) => setImmediate(resolve));
  const notice = feishu.adapter.posted.find((post) => post.destination.type === 'system-notice');
  assert.match(notice?.content.text ?? '', /^Feishu failed to connect: bad app\./);
});

test('a platform still connecting after the slow threshold is warned about once, then confirmed', async () => {
  setLocale('en');
  const handshake = deferred();
  const slack = fakePlatform('slack', [handshake]);
  const notices: SystemNoticeInput[] = [];
  const connections = await startPlatformAdapters(slack.adapter, { slowConnectMs: 5, notify: (notice) => { notices.push(notice); } });
  while (notices.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(notices[0].level, 'warning');
  assert.match(notices[0].text, /^Slack hasn't connected after 0s and is still retrying\./);

  handshake.resolve();
  await connections.settled;
  assert.deepEqual(notices.slice(1), [{ level: 'info', title: 'Slack', text: 'Slack connected.' }]);
});

test('stop() during a handshake closes the connection it later produces and never retries', async () => {
  const handshake = deferred();
  const slack = fakePlatform('slack', [handshake]);
  const connections = await startPlatformAdapters(slack.adapter, { retryDelaysMs: [1], notify: never });

  await connections.stop();
  assert.deepEqual(slack.calls, ['start', 'stop']);

  handshake.resolve();
  await connections.settled;
  assert.deepEqual(slack.calls, ['start', 'stop', 'stop']);
});

test('stop() during a handshake that then fails neither retries nor reports', async () => {
  const handshake = deferred();
  const feishu = fakePlatform('feishu', [handshake]);
  const connections = await startPlatformAdapters(feishu.adapter, { retryDelaysMs: [1], notify: never });

  await connections.stop();
  handshake.reject(new Error('Feishu adapter stopped'));
  await connections.settled;
  assert.deepEqual(feishu.calls, ['start', 'stop']);
});

test('stop() during the wait before a retry cancels the retry', async () => {
  const slack = fakePlatform('slack', [new Error('busy')]);
  const connections = await startPlatformAdapters(slack.adapter, { retryDelaysMs: [60_000], notify: never });
  while (!slack.calls.includes('stop')) await new Promise((resolve) => setImmediate(resolve));

  await connections.stop();
  await connections.settled;
  assert.deepEqual(slack.calls, ['start', 'stop', 'stop']);
});
