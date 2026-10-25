import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { RETENTION_STATEMENTS, applyRetention, retentionCutoffs } from '../src/retention.js';
import { NOW } from './fixtures.js';
import { sqliteD1, type TestDatabase } from './helpers/sqlite-d1.js';

const OLD_SAMPLE = '2026-07-20T00:00:00.000Z';     // > 90 days before NOW
const FRESH_SAMPLE = '2026-08-01T00:00:00.000Z';   // < 90 days before NOW
const OLD_AGGREGATE = '2025-09-01T00:00:00.000Z';  // > 13 months before NOW
const FRESH_AGGREGATE = '2025-10-01T00:00:00.000Z'; // < 13 months before NOW

function seed(t: TestDatabase, id: string, sampleAt: string, aggregateAt: string): void {
  const sampleDay = sampleAt.slice(0, 10);
  const aggregateDay = aggregateAt.slice(0, 10);
  const run = (sql: string, ...values: Array<string | number>) => t.raw.prepare(sql).run(...values);
  run(`INSERT INTO installs VALUES (?, ?, ?, '1', 'release', 'npm', 'linux', '6', 'x64', 22, 'en', NULL)`, id, aggregateAt, aggregateAt);
  run(`INSERT INTO install_days VALUES (?, ?, 1, '1', 'release', 'npm', 'linux', NULL)`, id, aggregateDay);
  run(`INSERT INTO crashes (install_id, component, group_key, version, channel, count, first_seen, last_seen, kind,
    error_name, message, stack) VALUES (?, 'server', 'g', '1', 'release', 1, ?, ?, 'panic', 'E', 'm', 's')`, id, sampleAt, sampleAt);
  run(`INSERT INTO errors VALUES (?, ?, 'store/fs', 'g', '1', 'release', 1, 'm')`, id, sampleDay);
  run(`INSERT INTO daily VALUES (?, ?, '1', 'release', 'npm', 'linux', ?, '{}')`, id, aggregateDay, aggregateAt);
  run(`INSERT INTO heartbeats VALUES (?, ?, '1', 'release', ?, '{}')`, id, aggregateDay, aggregateAt);
  run(`INSERT INTO funnel VALUES (?, 'first_session', 'server', NULL, ?, '1', 'release', 'npm', 'linux')`, id, aggregateAt);
  run(`INSERT INTO upgrades (install_id, at, channel, from_version, to_version, method, stage)
    VALUES (?, ?, 'release', '1', '2', 'auto', 'confirmed')`, id, sampleAt);
  run(`INSERT INTO migration_failures (install_id, at, version, channel, migration, error_class, message)
    VALUES (?, ?, '1', 'release', 'm1', 'io', 'm')`, id, sampleAt);
}

function idsIn(t: TestDatabase, table: string): string[] {
  return t.rows(`SELECT DISTINCT install_id FROM ${table} ORDER BY install_id`).map(row => String(row.install_id));
}

test('cutoffs are 90 days for samples and 13 calendar months for aggregates', () => {
  assert.deepEqual(retentionCutoffs(NOW), {
    sampleAt: '2026-07-26T15:00:00.000Z',
    sampleDay: '2026-07-26',
    aggregateAt: '2025-09-24T15:00:00.000Z',
    aggregateDay: '2025-09-24',
  });
});

test('the sweep deletes exactly the rows past their retention', async () => {
  const t = sqliteD1();
  seed(t, 'a-old', OLD_SAMPLE, OLD_AGGREGATE);
  seed(t, 'b-fresh', FRESH_SAMPLE, FRESH_AGGREGATE);
  await applyRetention(t.db, NOW);
  const tables = [...new Set(RETENTION_STATEMENTS.map(([sql]) => sql.split(' ')[2]))];
  assert.equal(tables.length, 9);
  for (const table of tables) assert.deepEqual(idsIn(t, table), ['b-fresh'], table);
});

test('the scheduled handler runs the sweep at the scheduled time', async () => {
  const t = sqliteD1();
  seed(t, 'a-old', OLD_SAMPLE, OLD_AGGREGATE);
  const pending: Promise<unknown>[] = [];
  worker.scheduled({ cron: '17 3 * * *', scheduledTime: NOW.getTime() }, { DB: t.db }, {
    waitUntil: promise => { pending.push(promise); },
  });
  await Promise.all(pending);
  assert.deepEqual(idsIn(t, 'crashes'), []);
  assert.deepEqual(idsIn(t, 'installs'), []);
});
