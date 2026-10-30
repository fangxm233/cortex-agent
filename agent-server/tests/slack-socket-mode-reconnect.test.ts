// Shutting down while Slack's socket-mode client is mid-reconnect must not leak an unhandled
// rejection: the reconnect's start() rejects with `undefined` when stop() lands before `hello`.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SocketModeReceiver } from '@slack/bolt';
import { silentLogger, startFakeSlack } from './helpers/fake-slack.js';

const rejections: unknown[] = [];
const onRejection = (reason: unknown) => { rejections.push(reason); };
const cleanups: (() => Promise<unknown>)[] = [];

beforeEach(() => {
  rejections.length = 0;
  process.on('unhandledRejection', onRejection);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
  process.off('unhandledRejection', onRejection);
});

test('stopping during a pending reconnect leaks no unhandled rejection', async () => {
  const slack = await startFakeSlack();
  cleanups.push(slack.close);
  slack.script.push('hello', 'silent');
  // The first reconnect waits clientPingTimeout ms; pongs from the local server arrive well within it.
  const receiver = new SocketModeReceiver({
    appToken: 'xapp-test',
    logger: silentLogger,
    clientPingTimeout: 200,
    installerOptions: { clientOptions: { slackApiUrl: slack.apiUrl } },
  });
  cleanups.push(() => receiver.stop());

  await receiver.start();
  slack.sockets[0].terminate();
  // The reconnect's start() has opened a new socket and now waits for a `hello` that never comes.
  await vi.waitFor(() => expect(slack.sockets).toHaveLength(2), { timeout: 5000, interval: 5 });

  const disconnected = new Promise((resolve) => receiver.client.once('disconnected', resolve));
  await receiver.stop();
  await disconnected;
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(rejections).toEqual([]);
});
