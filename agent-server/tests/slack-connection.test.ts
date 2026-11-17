// Slack's socket-mode client stops reconnecting for good when a reconnect's apps.connections.open
// fails unrecoverably. SlackConnection restarts it with capped backoff until it is stopped.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SlackConnection } from '../src/platform/adapters/slack-connection.js';
import { SLOW_REPLY_MS, silentLogger, startFakeSlack, type FakeSlack } from './helpers/fake-slack.js';

const rejections: unknown[] = [];
const onRejection = (reason: unknown) => { rejections.push(reason); };
const cleanups: (() => Promise<unknown>)[] = [];
let warnings: string[] = [];

beforeEach(() => {
  rejections.length = 0;
  warnings = [];
  process.on('unhandledRejection', onRejection);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.join(' ')); });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
  process.off('unhandledRejection', onRejection);
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 5 });
const retryWarnings = () => warnings.filter((line) => line.includes('reconnecting in'));

async function connectTo(retryDelayMs: number): Promise<{ slack: FakeSlack; connection: SlackConnection }> {
  const slack = await startFakeSlack();
  cleanups.push(slack.close);
  // socket-mode itself retries after clientPingTimeout ms; the local server answers pings at once.
  const connection = new SlackConnection(
    { botToken: 'xoxb-test', signingSecret: 'secret', appToken: 'xapp-test' },
    { slackApiUrl: slack.apiUrl, clientPingTimeout: 100, retryDelayMs, maxRetryDelayMs: 2 * retryDelayMs, logger: silentLogger },
  );
  cleanups.push(() => connection.stop());
  return { slack, connection };
}

function expectConnected(slack: FakeSlack, hellos: number): Promise<void> {
  return eventually(() => {
    expect(slack.stats.hellos).toBe(hellos);
    expect(slack.stats.openSockets).toBe(1);
  });
}

test('restarts the connection after socket-mode gives up, resetting the backoff once connected', async () => {
  const { slack, connection } = await connectTo(10);
  const received: string[] = [];
  connection.app.event('message', async ({ event }) => { received.push((event as { text: string }).text); });
  await connection.start();

  // socket-mode retries the drop itself and gives up on invalid_auth, twice; the second give-up
  // comes from the reconnect SlackConnection started.
  slack.script.push('drop', 'invalid_auth', 'drop', 'invalid_auth');
  slack.sockets[0].terminate();
  await expectConnected(slack, 2);
  expect(slack.stats.openCalls).toBe(6);
  expect(retryWarnings()).toEqual([
    expect.stringMatching(/auth error: invalid_auth.*attempt 1/),
    expect.stringMatching(/auth error: invalid_auth.*attempt 2/),
  ]);
  expect(connection.retryPending).toBe(false);

  slack.sockets.at(-1)!.send(JSON.stringify({
    type: 'events_api',
    envelope_id: 'env-1',
    payload: {
      type: 'event_callback', team_id: 'T0', api_app_id: 'A0', event_id: 'Ev1', event_time: 1,
      event: { type: 'message', channel: 'C0', user: 'U1', text: 'after reconnect', ts: '1.000' },
    },
  }));
  await eventually(() => expect(received).toEqual(['after reconnect']));

  slack.script.push('invalid_auth');
  slack.sockets.at(-1)!.terminate();
  await expectConnected(slack, 3);
  expect(retryWarnings()[2]).toMatch(/attempt 1\b/);
  expect(slack.stats.maxOpenSockets).toBe(1);
  expect(rejections).toEqual([]);
});

test('stop() during the backoff cancels the pending reconnect', async () => {
  const { slack, connection } = await connectTo(150);
  await connection.start();
  slack.script.push('invalid_auth');
  slack.sockets[0].terminate();
  await eventually(() => expect(connection.retryPending).toBe(true));

  await connection.stop();
  expect(connection.retryPending).toBe(false);
  const openCalls = slack.stats.openCalls;
  await sleep(400);

  expect(slack.stats.openCalls).toBe(openCalls);
  expect(slack.sockets).toHaveLength(1);
  expect(retryWarnings()).toHaveLength(1);
  expect(rejections).toEqual([]);
});

test('stop() while the socket URL is being fetched opens no socket', async () => {
  const { slack, connection } = await connectTo(10);
  slack.script.push('slow');
  const starting = connection.start().then(() => 'connected', (error: unknown) => error);
  await eventually(() => expect(slack.stats.openCalls).toBe(1));

  await connection.stop();
  expect(await starting).toBeInstanceOf(Error);
  await sleep(SLOW_REPLY_MS);

  expect(slack.sockets).toHaveLength(0);
  expect(connection.retryPending).toBe(false);
  expect(rejections).toEqual([]);
});

test('an auth.test failure at startup rejects start() without an unhandled rejection; the next start recovers', async () => {
  const slack = await startFakeSlack();
  cleanups.push(slack.close);
  slack.authScript.push('invalid_auth');
  const connection = new SlackConnection(
    { botToken: 'xoxb-test', signingSecret: 'secret', appToken: 'xapp-test' },
    { slackApiUrl: slack.apiUrl, clientPingTimeout: 100, logger: silentLogger },
  );
  cleanups.push(() => connection.stop());
  const received: string[] = [];
  connection.app.event('message', async ({ event }) => { received.push((event as { text: string }).text); });
  await sleep(50);
  expect(slack.stats.authCalls).toBe(0);

  await expect(connection.start()).rejects.toThrow(/invalid_auth/);
  expect(slack.stats.openCalls).toBe(0);

  await connection.start();
  await expectConnected(slack, 1);
  slack.sockets[0].send(JSON.stringify({
    type: 'events_api',
    envelope_id: 'env-1',
    payload: {
      type: 'event_callback', team_id: 'T0', api_app_id: 'A0', event_id: 'Ev1', event_time: 1,
      event: { type: 'message', channel: 'C0', user: 'U1', text: 'after auth', ts: '1.000' },
    },
  }));
  await eventually(() => expect(received).toEqual(['after auth']));
  expect(slack.stats.authCalls).toBe(2);
  expect(rejections).toEqual([]);
});
