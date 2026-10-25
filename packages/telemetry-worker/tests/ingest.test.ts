import test from 'node:test';
import assert from 'node:assert/strict';
import { TELEMETRY_MAX_BATCH_BYTES } from '../../../agent-server/src/domain/telemetry/schema.js';
import { createAccessVerifier } from '../src/access.js';
import type { Env } from '../src/env.js';
import { handleRequest } from '../src/index.js';
import { allowedEvents, DAILY_EVENT_CAP } from '../src/ingest.js';
import { INSTALL_ID, NOW, crashEvent, dailyEvent, everyEventType, sampleBatch } from './fixtures.js';
import { sqliteD1, type TestDatabase } from './helpers/sqlite-d1.js';

const deps = { verifier: createAccessVerifier(async () => new Response('{}')), now: NOW };

function post(body: unknown, init: { headers?: Record<string, string>; country?: string } = {}): Request {
  const request = new Request('https://telemetry.example.com/v1/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  if (init.country) Object.defineProperty(request, 'cf', { value: { country: init.country } });
  return request;
}

function setup(): TestDatabase & { env: Env } {
  const database = sqliteD1();
  return { ...database, env: { DB: database.db } };
}

function count(t: TestDatabase, table: string): number {
  return Number(t.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n);
}

test('a batch with every event type is stored and answered with 204', async () => {
  const t = setup();
  const response = await handleRequest(post(sampleBatch(), { country: 'DE' }), t.env, deps);
  assert.equal(response.status, 204);

  const install = t.rows('SELECT * FROM installs')[0];
  assert.equal(install.install_id, INSTALL_ID);
  assert.equal(install.country, 'DE');
  assert.equal(install.first_seen, NOW.toISOString());
  assert.equal(install.install_form, 'desktop');
  assert.deepEqual(t.rows('SELECT day, events FROM install_days'), [{ day: '2026-10-24', events: 11 }]);
  assert.equal(count(t, 'crashes'), 3);
  assert.equal(count(t, 'heartbeats'), 1);
  assert.equal(count(t, 'upgrades'), 1);
  assert.equal(count(t, 'migration_failures'), 1);
  assert.equal(count(t, 'funnel'), 4);
  assert.deepEqual(t.rows('SELECT module, count FROM errors'), [{ module: 'store/fs', count: 14 }]);

  const daily = t.rows("SELECT json_extract(payload, '$.errors') AS errors, payload FROM daily")[0];
  assert.deepEqual(JSON.parse(String(daily.errors)), { byModule: { 'store/fs': 14, 'platform/feishu': 2 } });
  const exit = t.rows("SELECT exit_code, backoff_ms FROM crashes WHERE component = 'daemon'")[0];
  assert.deepEqual(exit, { exit_code: 1, backoff_ms: 2000 });
});

test('the client address is never stored', async () => {
  const t = setup();
  const address = '203.0.113.77';
  const headers = { 'cf-connecting-ip': address, 'x-forwarded-for': address, 'x-real-ip': address };
  assert.equal((await handleRequest(post(sampleBatch(), { headers }), t.env, deps)).status, 204);
  const tables = t.rows("SELECT name FROM sqlite_master WHERE type = 'table'").map(row => String(row.name));
  for (const table of tables) {
    assert.ok(!JSON.stringify(t.rows(`SELECT * FROM ${table}`)).includes(address), table);
  }
});

test('malformed JSON and schema violations answer 400 and store nothing', async () => {
  const t = setup();
  const bad = sampleBatch();
  const cases: unknown[] = [
    '{"envelope":',
    { ...bad, envelope: { ...bad.envelope, installId: 'not-a-uuid' } },
    { ...bad, events: [{ type: 'pageview', at: NOW.toISOString() }] },
    { ...bad, events: [] },
    { ...bad, events: [dailyEvent('2026-10-23', { uiOps: { 'has space': 1 } })] },
    { ...bad, events: [dailyEvent('2026-10-23', { tools: [{ name: 'Bash', calls: -1, errors: 0 }] })] },
    { ...bad, events: Array.from({ length: 201 }, () => ({ ...everyEventType()[6] })) },
    { ...bad, events: [{ ...crashEvent(), prompt: undefined, stack: 'x'.repeat(8_001) }] },
  ];
  for (const body of cases) {
    const response = await handleRequest(post(body), t.env, deps);
    assert.equal(response.status, 400);
    const payload = await response.json() as { error: string };
    assert.match(payload.error, /invalid/);
  }
  assert.equal(count(t, 'install_days'), 0);
  assert.equal(count(t, 'installs'), 0);
});

test('validation errors report paths, not submitted values', async () => {
  const t = setup();
  const secret = 'sk-ant-api03-very-secret-value';
  const body = sampleBatch({ arch: secret.repeat(2) });
  const response = await handleRequest(post(body), t.env, deps);
  const text = await response.text();
  assert.equal(response.status, 400);
  assert.ok(text.includes('envelope.arch'));
  assert.ok(!text.includes(secret));
});

test('bodies over the size cap answer 413, declared or streamed', async () => {
  const t = setup();
  const oversized = 'x'.repeat(TELEMETRY_MAX_BATCH_BYTES + 1);
  assert.equal((await handleRequest(post(oversized), t.env, deps)).status, 413);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 17; i++) controller.enqueue(new Uint8Array(4096));
      controller.close();
    },
  });
  const chunked = new Request('https://telemetry.example.com/v1/batch', {
    method: 'POST', body: stream, duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  assert.equal((await handleRequest(chunked, t.env, deps)).status, 413);
  assert.equal(count(t, 'install_days'), 0);
});

test('allowedEvents clamps to what is left of the daily cap', () => {
  assert.equal(allowedEvents(10, 10), 10);
  assert.equal(allowedEvents(DAILY_EVENT_CAP, 10), 10);
  assert.equal(allowedEvents(DAILY_EVENT_CAP + 3, 10), 7);
  assert.equal(allowedEvents(DAILY_EVENT_CAP + 50, 10), 0);
});

test('events past the per-install daily cap are dropped with 429', async () => {
  const t = setup();
  t.raw.prepare(`INSERT INTO install_days (install_id, day, events, version, channel, install_form, os)
    VALUES (?, ?, ?, '2026.10.24', 'release', 'desktop', 'win32')`).run(INSTALL_ID, '2026-10-24', DAILY_EVENT_CAP - 2);
  const crashes = Array.from({ length: 5 }, (_, i) => crashEvent({ groupKey: `group-${i}` }));

  const partial = await handleRequest(post(sampleBatch({}, crashes)), t.env, deps);
  assert.equal(partial.status, 429);
  assert.deepEqual(await partial.json(), { error: 'daily event cap reached', accepted: 2, dropped: 3 });
  assert.deepEqual(t.rows('SELECT group_key FROM crashes ORDER BY group_key').map(row => row.group_key), ['group-0', 'group-1']);

  const refused = await handleRequest(post(sampleBatch({}, crashes)), t.env, deps);
  assert.equal(refused.status, 429);
  assert.equal(count(t, 'crashes'), 2);

  const nextDay = { ...deps, now: new Date('2026-10-25T00:00:01.000Z') };
  assert.equal((await handleRequest(post(sampleBatch({}, crashes)), t.env, nextDay)).status, 204);
  assert.equal(count(t, 'crashes'), 5);
});

test('resent rollups and funnel steps do not double count; crashes accumulate per group', async () => {
  const t = setup();
  await handleRequest(post(sampleBatch()), t.env, deps);
  const resend = [dailyEvent(), ...everyEventType().filter(e => e.type === 'funnel'), crashEvent({ suppressed: 4, message: 'latest' })];
  await handleRequest(post(sampleBatch({ version: '2026.10.24' }, resend)), t.env, deps);

  assert.equal(count(t, 'daily'), 1);
  assert.deepEqual(t.rows('SELECT count FROM errors'), [{ count: 14 }]);
  assert.equal(count(t, 'funnel'), 4);
  const crash = t.rows("SELECT count, message FROM crashes WHERE component = 'server'")[0];
  assert.deepEqual(crash, { count: 6, message: 'latest' });
});

test('routes enforce method and path', async () => {
  const t = setup();
  const wrongMethod = await handleRequest(new Request('https://telemetry.example.com/v1/batch'), t.env, deps);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  const unknown = await handleRequest(new Request('https://telemetry.example.com/v1/events'), t.env, deps);
  assert.equal(unknown.status, 404);
  const health = await handleRequest(new Request('https://telemetry.example.com/health'), t.env, deps);
  assert.equal(health.status, 200);
});
