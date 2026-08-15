// input:  the Python proxy-export golden files and hand-built journal totals
// output: tagged-union, purity, input-validation and unaccounted-role proofs
// pos:    Accounting record tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

// There is no proxy-vs-journal comparison left to test. It was removed deliberately — the two sides
// priced the same tokens from different price lists and a 12.7x disagreement between two individually
// correct figures discarded a finished trial (see `accounting-reconciliation.ts`). What is tested
// here is what survived: that a figure nobody read can never wear the shape of a zero, that the
// builder is pure, that malformed input is refused, that the A4 request excess is still listed, and
// that the bytes the Python side emits parse on this side.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ACCOUNTING_RECORD_SCHEMA_VERSION,
  AccountingInputError,
  buildAccountingRecord,
  journalCostFromNumber,
  type AccountingRecord,
  type Available,
  type JournalTotals,
  type ProxyExport,
} from '../../../src/domain/benchmark/accounting-reconciliation.js';

const GOLDEN_DIR = fileURLToPath(
  new URL('../../../../benchmark/harness/tests/proxy/golden/', import.meta.url),
);

/** The bytes the Python side committed, parsed exactly as they were emitted. */
function proxyGolden(name: string): ProxyExport {
  return JSON.parse(readFileSync(`${GOLDEN_DIR}${name}`, 'utf8')) as ProxyExport;
}

function journal(overrides: Partial<JournalTotals> = {}): JournalTotals {
  return {
    requests: { status: 'available', value: 3 },
    cost_usd: { status: 'available', value: '0.000153' },
    steps: { status: 'available', value: 7 },
    tokens: {
      input: { status: 'available', value: 6 },
      output: { status: 'available', value: 9 },
      cached: { status: 'available', value: 0 },
    },
    roles: ['parent', 'coder', 'reviewer'],
    source: 'trajectory_merge',
    ...overrides,
  };
}

function taggedSlots(document: unknown, path = ''): [string, Record<string, unknown>][] {
  if (document === null || typeof document !== 'object') return [];
  const node = document as Record<string, unknown>;
  if (typeof node.status === 'string') return [[path, node]];
  return Object.entries(node).flatMap(([key, value]) => taggedSlots(value, `${path}.${key}`));
}

describe('the record shape', () => {
  it('carries every figure as a tagged union, never as a bare number', () => {
    const record = buildAccountingRecord(proxyGolden('proxy-export-echoed.json'), journal());

    const slots = taggedSlots(record);
    expect(slots.length).toBeGreaterThan(8);
    for (const [path, slot] of slots) {
      expect(['available', 'unavailable'], path).toContain(slot.status);
      if (slot.status === 'unavailable') expect(typeof slot.reason, path).toBe('string');
    }
    expect(record.schema_version).toBe(ACCOUNTING_RECORD_SCHEMA_VERSION);
    expect(record.trial_id).toBe('trial-export');
  });

  /**
   * The record is a STATEMENT of both sides' figures, not a verdict on whether they agree. This
   * assertion is the guard against reinstating the comparison: `tolerance`, `deltas`, `reconciled`
   * and `checks` were removed on purpose and a restored one fails here.
   */
  it('states both sides figures and reaches no verdict about them', () => {
    const record = buildAccountingRecord(proxyGolden('proxy-export-echoed.json'), journal());

    expect(Object.keys(record)).toEqual([
      'schema_version', 'trial_id', 'proxy', 'journal', 'unaccounted_roles',
    ]);
    expect(ACCOUNTING_RECORD_SCHEMA_VERSION).toBe('cortex-bench-accounting/2');
  });

  /**
   * Load-bearing order: `composite-manifest.ts` compares `Object.keys(proxy).join(',')` against its
   * own `PROXY_KEYS` and a mismatch refuses the whole trial as `accounting_shape_invalid`. The proxy
   * has no `cost_usd`: it counts requests and meters tokens, and prices nothing.
   */
  it('builds the proxy side in its declared key order, with no cost slot', () => {
    const record = buildAccountingRecord(proxyGolden('proxy-export-echoed.json'), journal());

    expect(Object.keys(record.proxy)).toEqual([
      'requests', 'cached_tokens', 'input_tokens', 'output_tokens',
      'audit_log', 'lease_echo', 'source',
    ]);
    expect(Object.hasOwn(record.proxy, 'cost_usd')).toBe(false);
    // The journal keeps its own: it is the run's cache-aware figure and the one worth quoting.
    expect(record.journal.cost_usd).toEqual({ status: 'available', value: '0.000153' });
  });

  it('yields no zeros at all when nothing could be read', () => {
    const unreadable: ProxyExport = {
      schema_version: 'cortex-bench-proxy-export/1',
      trial_id: 'trial-dark',
      adapter_id: 'row-1',
      source: 'proxy_export',
      requests: { status: 'unavailable', reason: 'proxy_not_started' },
      cached_tokens: { status: 'unavailable', reason: 'proxy_not_started' },
      input_tokens: { status: 'unavailable', reason: 'proxy_not_started' },
      output_tokens: { status: 'unavailable', reason: 'proxy_not_started' },
      audit_log: { status: 'unavailable', reason: 'proxy_not_started' },
      lease_echo: { status: 'unavailable', reason: 'proxy_not_started' },
    };
    const blank = journal({
      requests: { status: 'unavailable', reason: 'journal_absent' },
      cost_usd: { status: 'unavailable', reason: 'journal_absent' },
      steps: { status: 'unavailable', reason: 'journal_absent' },
      tokens: {
        input: { status: 'unavailable', reason: 'journal_absent' },
        output: { status: 'unavailable', reason: 'journal_absent' },
        cached: { status: 'unavailable', reason: 'journal_absent' },
      },
      roles: [],
    });

    const record = buildAccountingRecord(unreadable, blank);

    for (const [path, slot] of taggedSlots(record)) {
      expect(slot.status, path).toBe('unavailable');
      expect(slot.value, path).toBeUndefined();
    }
    const figures = { proxy: record.proxy, journal: record.journal };
    expect(JSON.stringify(figures)).not.toContain(':0');
  });

  it('refuses a bare number where a tagged union belongs', () => {
    const smuggled = { ...proxyGolden('proxy-export-echoed.json'), requests: 0 } as unknown;

    expect(() => buildAccountingRecord(smuggled as ProxyExport, journal()))
      .toThrow(AccountingInputError);
  });

  it('refuses an unavailable reason outside the closed set', () => {
    const golden = proxyGolden('proxy-export-echoed.json');
    const smuggled = {
      ...golden, cached_tokens: { status: 'unavailable', reason: 'seemed_fine' },
    } as unknown;

    expect(() => buildAccountingRecord(smuggled as ProxyExport, journal()))
      .toThrow(AccountingInputError);
  });

  /**
   * `no_cache_breakdown_reported` is the reason the closed set grew: the counter WAS read and the
   * provider simply never reported a cache split. It is not `counter_unreadable`, and above all it
   * is not a zero — a response without a breakdown is not a cache miss.
   */
  it('admits no_cache_breakdown_reported as its own reason, distinct from an unread counter', () => {
    const golden = proxyGolden('proxy-export-echoed.json');
    const record = buildAccountingRecord(
      { ...golden, cached_tokens: { status: 'unavailable', reason: 'no_cache_breakdown_reported' } },
      journal(),
    );

    expect(record.proxy.cached_tokens).toEqual({
      status: 'unavailable', reason: 'no_cache_breakdown_reported',
    });
    expect(record.proxy.cached_tokens).not.toEqual({ status: 'available', value: 0 });
  });

  it('refuses a negative cost, which neither side can honestly have observed', () => {
    // The type system cannot tell a negative decimal string from a positive one, so the boundary
    // check is the thing that refuses it.
    const smuggled = journal({ cost_usd: { status: 'available' as const, value: '-0.5' } });

    expect(() => buildAccountingRecord(proxyGolden('proxy-export-echoed.json'), smuggled))
      .toThrow(AccountingInputError);
  });

  it('rejects a bare number at the type level', () => {
    const golden = proxyGolden('proxy-export-echoed.json');

    // @ts-expect-error a slot may not hold a bare number — this is the A5 rule as a type
    const smuggled: ProxyExport = { ...golden, requests: 0 };

    expect(smuggled.requests).toBe(0);
  });
});

describe('purity', () => {
  it('writes no file and mutates neither input', async () => {
    const poison = new Proxy({}, {
      get(_target, property) {
        // The module loader probes these before any user code sees the namespace.
        if (property === 'then' || property === Symbol.toStringTag) return undefined;
        throw new Error(`the accounting record touched the file system: ${String(property)}`);
      },
    });
    vi.doMock('node:fs', () => poison);
    vi.doMock('node:fs/promises', () => poison);
    vi.resetModules();
    const module = await import('../../../src/domain/benchmark/accounting-reconciliation.js');

    const proxyInput = proxyGolden('proxy-export-echoed.json');
    const journalInput = journal();
    const proxySnapshot = structuredClone(proxyInput);
    const journalSnapshot = structuredClone(journalInput);

    const record: AccountingRecord = module.buildAccountingRecord(
      Object.freeze(proxyInput), Object.freeze(journalInput),
    );

    expect(record.trial_id).toBe('trial-export');
    expect(proxyInput).toEqual(proxySnapshot);
    expect(journalInput).toEqual(journalSnapshot);
    // Freezing the record must not reach back into the caller's own document through a shared
    // reference: an input that came out sealed was mutated, however equal its values still compare.
    for (const slot of [proxyInput.audit_log, proxyInput.lease_echo]) {
      expect(slot.status).toBe('available');
      expect(Object.isFrozen((slot as Available<Record<string, unknown>>).value)).toBe(false);
    }
    vi.doUnmock('node:fs');
    vi.doUnmock('node:fs/promises');
  });

  it('returns a frozen record', () => {
    const record = buildAccountingRecord(proxyGolden('proxy-export-echoed.json'), journal());

    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.proxy)).toBe(true);
    expect(Object.isFrozen(record.unaccounted_roles)).toBe(true);
  });
});

describe('the journal cost is carried, never re-derived', () => {
  it('survives a value a binary float would corrupt', () => {
    const exact = '9007199254740993.0000001';
    const record = buildAccountingRecord(
      proxyGolden('proxy-export-echoed.json'),
      journal({ cost_usd: { status: 'available', value: exact } }),
    );

    expect(record.journal.cost_usd).toEqual({ status: 'available', value: exact });
    expect(String(Number(exact))).not.toBe(exact);
  });

  it('converts the journal boundary from a number to a decimal string', () => {
    expect(journalCostFromNumber(0.1)).toEqual({ status: 'available', value: '0.1' });
    expect(journalCostFromNumber(1e-7)).toEqual({ status: 'available', value: '0.0000001' });
    expect(journalCostFromNumber(0)).toEqual({ status: 'available', value: '0' });
    expect(journalCostFromNumber(Number.NaN))
      .toEqual({ status: 'unavailable', reason: 'journal_underivable' });
    expect(journalCostFromNumber(null))
      .toEqual({ status: 'unavailable', reason: 'journal_underivable' });
  });
});

/**
 * A4/OC-11 survived the removal of the proxy-vs-journal reconciliation, and deliberately so: it is
 * denominated in REQUESTS, a count both sides genuinely observe, rather than in a cost each side
 * derives from its own price list. It raises no check and carries no failure code — it lists.
 */
describe('A4 — a role the DAG never recorded is listed, not absorbed', () => {
  it('lists the proxy excess as a request count', () => {
    const record = buildAccountingRecord(
      proxyGolden('proxy-export-echoed.json'),
      journal({ requests: { status: 'available', value: 1 }, roles: ['parent'] }),
    );

    expect(record.unaccounted_roles).toEqual([{
      kind: 'proxy_excess',
      journal_roles: ['parent'],
      requests: { status: 'available', value: 2 },
    }]);
  });

  it('lists nothing when the journal accounts for every request', () => {
    const record = buildAccountingRecord(proxyGolden('proxy-export-echoed.json'), journal());

    expect(record.unaccounted_roles).toEqual([]);
  });

  it('lists nothing when the journal claims more than the proxy saw', () => {
    const record = buildAccountingRecord(
      proxyGolden('proxy-export-echoed.json'),
      journal({ requests: { status: 'available', value: 5 } }),
    );

    expect(record.unaccounted_roles).toEqual([]);
  });

  /**
   * The journal has no request counter of its own — `MetricAccumulator` carries no such figure — so
   * in production this side is permanently `journal_underivable`. An excess that cannot be computed
   * is not reported as zero excess; it simply goes unlisted.
   */
  it('lists nothing when the journal side cannot be counted at all', () => {
    const record = buildAccountingRecord(
      proxyGolden('proxy-export-echoed.json'),
      journal({ requests: { status: 'unavailable', reason: 'journal_underivable' } }),
    );

    expect(record.unaccounted_roles).toEqual([]);
  });
});

describe('the cross-language seam', () => {
  it('parses the bytes the Python export actually emitted', () => {
    const golden = proxyGolden('proxy-export-echoed.json');

    const record = buildAccountingRecord(golden, journal());

    expect(record.proxy.requests).toEqual({ status: 'available', value: 3 });
    expect(record.proxy.input_tokens).toEqual({ status: 'available', value: 6 });
    expect(record.proxy.output_tokens).toEqual({ status: 'available', value: 9 });
    // The synthetic upstream reports no cache breakdown. A silent provider is not a cache miss, so
    // the figure crosses the seam unavailable rather than as a zero nobody measured.
    expect(record.proxy.cached_tokens).toEqual({
      status: 'unavailable', reason: 'no_cache_breakdown_reported',
    });
    expect(record.proxy.lease_echo).toEqual({
      status: 'available',
      value: {
        absolute_epoch_ms: 1700001800000,
        armed_remaining_ms: 1680000,
        budget_ms: 1800000,
        compiled_at_epoch_ms: 1700000000000,
        consumed_ms: 120000,
        lease_state: 'reconciled',
      },
    });
    // The Python side stopped exporting a cost slot when it stopped pricing what it meters.
    expect(Object.hasOwn(golden, 'cost_usd')).toBe(false);
  });

  it('carries the no-echo trial through as an unavailable lease record', () => {
    const golden = proxyGolden('proxy-export-no-echo.json');

    const record = buildAccountingRecord(golden, journal({
      requests: { status: 'available', value: 2 },
      tokens: {
        input: { status: 'available', value: 4 },
        output: { status: 'available', value: 6 },
        cached: { status: 'available', value: 0 },
      },
    }));

    expect(record.proxy.lease_echo).toEqual({
      status: 'unavailable', reason: 'no_echo_received',
    });
    expect(record.proxy.requests).toEqual({ status: 'available', value: 2 });
  });
});
