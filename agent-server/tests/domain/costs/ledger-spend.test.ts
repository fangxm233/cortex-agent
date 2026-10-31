import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CostRepo } from '../../../src/store/cost-repo.js';
import type { CostEntry } from '../../../src/domain/costs/cost-tracker.js';
import { ledgerSpend, type LedgerSpendRow } from '../../../src/domain/costs/ledger-spend.js';
import { billingTable } from '../../usage-service-fixtures.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Midday today: real time, since the repository prunes against the real clock. */
function middayToday(): Date {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  return now;
}

type Row = Record<string, unknown>;

function at(now: Date, ageMs: number): string {
  return new Date(now.getTime() - ageMs).toISOString();
}

/** A row written before connections existed: only the plan/api bucket, no connection column. */
function legacy(now: Date, ageMs: number, fields: Row): Row {
  return { timestamp: at(now, ageMs), project: 'nimbus', trigger: 'user', num_turns: null, duration_s: null, source: 'estimate', ...fields };
}

/** A row as recordCost writes it now. */
function current(now: Date, ageMs: number, fields: Row): Row {
  return legacy(now, ageMs, { input_tokens: 10, output_tokens: 20, cache_read_tokens: 300, cache_creation_tokens: 40, model: 'm', ...fields });
}

function syntheticLedger(now: Date): Row[] {
  return [
    // Claude subscription: a current row and a gateway-era 'plan' row.
    current(now, 1 * HOUR, { backend: 'claude', mode: 'plan', connection: 'subscription', provider: 'anthropic', cost_usd: 5 }),
    legacy(now, 10 * DAY, { backend: 'claude', mode: 'plan', provider: 'anthropic', cost_usd: 7 }),
    // Claude on a metered key connection, plus a gateway-era 'api' row whose relay is unknown.
    current(now, 2 * HOUR, { backend: 'claude', mode: 'api', connection: 'my-relay', provider: 'anthropic', cost_usd: 2 }),
    current(now, 10 * DAY, { backend: 'claude', mode: 'api', connection: 'my-relay', provider: 'anthropic', cost_usd: 3 }),
    current(now, 45 * DAY, { backend: 'claude', mode: 'api', connection: 'my-relay', provider: 'anthropic', cost_usd: 4 }),
    legacy(now, 5 * DAY, { backend: 'claude', mode: 'api', cost_usd: 1 }),
    // PI on a subscription login (Codex), current and gateway-era.
    current(now, 3 * HOUR, { backend: 'pi', mode: 'api', connection: 'openai-codex', provider: 'openai-codex', cost_usd: 9 }),
    legacy(now, 3 * DAY, { backend: 'pi', mode: 'api', provider: 'openai-codex', cost_usd: 1 }),
    // PI on a metered key, one row without a price.
    current(now, 2 * HOUR, { backend: 'pi', mode: 'api', connection: 'deepseek', provider: 'deepseek', cost_usd: 0.5 }),
    current(now, 20 * DAY, { backend: 'pi', mode: 'api', connection: 'deepseek', provider: 'deepseek', cost_usd: 0.25 }),
    current(now, 1 * DAY, { backend: 'pi', mode: 'api', connection: 'deepseek', provider: 'deepseek', cost_usd: null }),
    // Idle for over 30 days: spend on record, but no row.
    current(now, 40 * DAY, { backend: 'pi', mode: 'api', connection: 'qwen-local', provider: 'qwen-local', cost_usd: 3 }),
    // A PI row naming no provider cannot be attributed.
    legacy(now, 1 * HOUR, { backend: 'pi', mode: 'api', cost_usd: 8 }),
  ];
}

async function readThroughRepo(rows: Row[]): Promise<CostEntry[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-spend-'));
  const costsPath = path.join(dir, 'costs.jsonl');
  await fs.writeFile(costsPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return (await new CostRepo({ costsPath, budgetPath: path.join(dir, 'budget.json') }).readCosts()).entries;
}

const byKey = (rows: LedgerSpendRow[]) => Object.fromEntries(rows.map((row) => [`${row.provider}::${row.billing}`, row]));

describe('ledgerSpend', () => {
  test('a mixed ledger yields one row per provider and billing, metered rows carrying spend', async () => {
    const now = middayToday();
    const rows = byKey(ledgerSpend(await readThroughRepo(syntheticLedger(now)), billingTable(), now));

    assert.deepEqual(Object.keys(rows).sort(), [
      'anthropic::api', 'anthropic::subscription', 'deepseek::api', 'openai-codex::subscription',
    ]);
    assert.deepEqual(rows['anthropic::subscription'], {
      provider: 'anthropic', billing: 'subscription', connections: ['subscription'], spend: null,
    });
    assert.deepEqual(rows['anthropic::api'], {
      provider: 'anthropic', billing: 'api', connections: ['my-relay'],
      spend: { today: 2, month: 6, all: 10 },
    }, 'the unknown gateway-era relay adds spend but no connection name');
    assert.deepEqual(rows['openai-codex::subscription'], {
      provider: 'openai-codex', billing: 'subscription', connections: ['openai-codex'], spend: null,
    });
    assert.deepEqual(rows['deepseek::api'], {
      provider: 'deepseek', billing: 'api', connections: ['deepseek'],
      spend: { today: 0.5, month: 0.75, all: 0.75 },
    });
  });

  test('billing is asked once per connection, by connection for Claude and by provider for PI', async () => {
    const now = middayToday();
    const billing = billingTable();
    ledgerSpend(await readThroughRepo(syntheticLedger(now)), billing, now);

    assert.deepEqual(billing.calls, [
      { backend: 'claude', provider: null, connection: 'subscription' },
      { backend: 'claude', provider: null, connection: 'my-relay' },
      { backend: 'pi', provider: 'openai-codex', connection: null },
      { backend: 'pi', provider: 'deepseek', connection: null },
      { backend: 'pi', provider: 'qwen-local', connection: null },
    ]);
  });

  test('a provider billed by a subscription login today reads as one even for older rows', async () => {
    const now = middayToday();
    const entries = await readThroughRepo([
      current(now, 1 * HOUR, { backend: 'pi', mode: 'api', connection: 'openai', provider: 'openai', cost_usd: 3 }),
    ]);

    const keyed = ledgerSpend(entries, billingTable(), now);
    const signedIn = ledgerSpend(entries, billingTable(['pi:openai']), now);

    assert.deepEqual(keyed.map((row) => [row.billing, row.spend]), [['api', { today: 3, month: 3, all: 3 }]]);
    assert.deepEqual(signedIn.map((row) => [row.billing, row.spend]), [['subscription', null]]);
  });

  test('the longest period is exactly the ledger\'s 90 days, whatever the file still holds', () => {
    const now = middayToday();
    const entry = (ageMs: number, cost: number) => ({
      ...current(now, ageMs, { backend: 'pi', mode: 'api', connection: 'deepseek', provider: 'deepseek', cost_usd: cost }),
    }) as unknown as CostEntry;

    const [row] = ledgerSpend([entry(1 * HOUR, 1), entry(89 * DAY, 2), entry(91 * DAY, 4)], billingTable(), now);

    assert.deepEqual(row.spend, { today: 1, month: 1, all: 3 });
  });
});
