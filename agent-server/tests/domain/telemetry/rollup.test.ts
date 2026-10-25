import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import {
  configureRollupStore, finishedRollups, persistRollup, updateRollup, wipeRollups,
} from '@domain/telemetry/rollup.js';
import { buildNameCatalog } from '@domain/telemetry/normalize.js';
import { toDailyEvent } from '@domain/telemetry/daily.js';
import { emptyRollup, emptyTurnRow } from '@domain/telemetry/rollup-types.js';
import { rollupFile } from '@domain/telemetry/paths.js';
import { DailyEventSchema } from '@domain/telemetry/schema.js';
import { enableTelemetryForTest } from './helpers.js';

let restore: () => void = () => {};
let dir = '';
let now = Date.parse('2026-10-01T23:50:00Z');
beforeEach(() => {
  restore = enableTelemetryForTest();
  dir = mkdtempSync(path.join(os.tmpdir(), 'telemetry-rollup-'));
  now = Date.parse('2026-10-01T23:50:00Z');
  configureRollupStore({ dir, now: () => now });
});
afterEach(() => {
  configureRollupStore({});
  restore();
});

const catalog = buildNameCatalog([{ provider: 'openai', id: 'gpt-5.6-sol' }], new Map([['lab-gw', 'openai-completions']]));

test('aggregates persist, survive a reload and rotate at the UTC day boundary', () => {
  updateRollup((rollup) => { rollup.features.board_opened = 2; });
  persistRollup();
  configureRollupStore({ dir, now: () => now });
  updateRollup((rollup) => { rollup.features.board_opened! += 1; });
  now = Date.parse('2026-10-02T00:10:00Z');
  updateRollup((rollup) => { rollup.features.worker_spawned = 1; });
  const finished = finishedRollups(now);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].day, '2026-10-01');
  assert.equal(finished[0].features.board_opened, 3);
  assert.equal(finished[0].features.worker_spawned, undefined);
});

test('backlog older than a week is dropped; wipe removes every rollup file', () => {
  updateRollup((rollup) => { rollup.features.board_opened = 1; });
  persistRollup();
  now = Date.parse('2026-10-20T00:00:00Z');
  assert.deepEqual(finishedRollups(now), []);
  assert.equal(existsSync(rollupFile('2026-10-01', dir)), false);
  updateRollup((rollup) => { rollup.features.board_opened = 1; });
  persistRollup();
  wipeRollups();
  assert.deepEqual(readdirSync(dir), []);
});

test('the daily event normalizes and merges turn rows and tools, and validates', () => {
  const rollup = emptyRollup('2026-10-01');
  const row = (provider: string, model: string) => {
    const value = emptyTurnRow('pi', provider, model, 'api');
    value.outcomes.completed = 2;
    value.ttftMs[0] = 2;
    return value;
  };
  rollup.turns.a = row('openai', 'gpt-5.6-sol');
  rollup.turns.b = row('openai', 'my-private-finetune');
  rollup.turns.c = row('ollama-home', 'llama-private');
  rollup.turns.d = row('lab-gw', 'secret-model');
  rollup.tools = {
    Bash: { calls: 5, errors: 1 }, 'mcp__github__x': { calls: 2, errors: 0 },
    'mcp__gitlab__y': { calls: 1, errors: 1 }, 'mcp__cortex-core__agent': { calls: 1, errors: 0 },
  };
  rollup.agent.sessionTurns = { s1: 1, s2: 3, s3: 3 };
  rollup.perf.eventLoopP99s = [5, 40, 10];
  rollup.errors.byModule = { 'ui-http': 2 };
  const event = toDailyEvent(rollup, catalog)!;
  assert.ok(DailyEventSchema.safeParse(event).success);
  const models = event.turns.map((turn) => `${turn.provider}/${turn.model}/${turn.customApi}`).sort();
  assert.deepEqual(models, ['custom/custom/openai-completions', 'openai/gpt-5.6-sol/null', 'openai/other/null', 'other/other/null']);
  const tools = Object.fromEntries(event.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(tools.mcp_other, { name: 'mcp_other', calls: 3, errors: 1 });
  assert.equal(tools['mcp__cortex-core__agent'].calls, 1);
  assert.deepEqual(event.agent.turnsPerSession, [1, 0, 2, 0, 0, 0, 0, 0]);
  assert.deepEqual(event.perf.eventLoop, { windows: 3, p99MedianMs: 10, p99MaxMs: 40 });
  const text = JSON.stringify(event);
  for (const secret of ['ollama-home', 'llama-private', 'lab-gw', 'secret-model', 'my-private-finetune', 'github', 's1']) {
    assert.ok(!text.includes(secret), secret);
  }
});

test('finished days are queued as daily events and removed locally', async () => {
  const { queueFinishedDays } = await import('@domain/telemetry/daily-upload.js');
  const { takeOutbox } = await import('@domain/telemetry/outbox.js');
  updateRollup((rollup) => { rollup.features.board_opened = 4; });
  persistRollup();
  now = Date.parse('2026-10-02T00:20:00Z');
  await queueFinishedDays(now, async () => catalog);
  const events = takeOutbox();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'daily');
  assert.equal((events[0] as { day: string }).day, '2026-10-01');
  assert.equal(existsSync(rollupFile('2026-10-01', dir)), false);
});
