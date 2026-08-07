// input:  the Python proxy-export golden files and hand-built journal totals
// output: tagged-union, purity, tolerance, operand and unaccounted-role proofs
// pos:    Accounting reconciliation tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ACCOUNTING_RECORD_SCHEMA_VERSION,
  AccountingInputError,
  DEFAULT_ACCOUNTING_TOLERANCE,
  journalCostFromNumber,
  reconcileAccounting,
  type AccountingCheck,
  type AccountingRecord,
  type AccountingTolerance,
  type Available,
  type JournalTotals,
  type ProxyExport,
} from '../../../src/domain/benchmark/accounting-reconciliation.js';
import { BENCHMARK_FAILURES } from '../../../src/domain/benchmark/resolved-policy.js';

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

function checkIds(record: AccountingRecord): string[] {
  return record.checks.map(check => check.check_id);
}

function failedChecks(record: AccountingRecord): AccountingCheck[] {
  return record.checks.filter(check => !check.passed);
}

function taggedSlots(document: unknown, path = ''): [string, Record<string, unknown>][] {
  if (document === null || typeof document !== 'object') return [];
  const node = document as Record<string, unknown>;
  if (typeof node.status === 'string') return [[path, node]];
  return Object.entries(node).flatMap(([key, value]) => taggedSlots(value, `${path}.${key}`));
}

describe('the record shape', () => {
  it('carries every figure as a tagged union, never as a bare number', () => {
    const record = reconcileAccounting(proxyGolden('proxy-export-echoed.json'), journal());

    const slots = taggedSlots(record);
    expect(slots.length).toBeGreaterThan(8);
    for (const [path, slot] of slots) {
      expect(['available', 'unavailable'], path).toContain(slot.status);
      if (slot.status === 'unavailable') expect(typeof slot.reason, path).toBe('string');
    }
    expect(record.schema_version).toBe(ACCOUNTING_RECORD_SCHEMA_VERSION);
    expect(record.trial_id).toBe('trial-export');
  });

  it('yields no zeros at all when nothing could be read', () => {
    const unreadable: ProxyExport = {
      schema_version: 'cortex-bench-proxy-export/1',
      trial_id: 'trial-dark',
      adapter_id: 'row-1',
      source: 'proxy_export',
      requests: { status: 'unavailable', reason: 'proxy_not_started' },
      cost_usd: { status: 'unavailable', reason: 'proxy_not_started' },
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

    const record = reconcileAccounting(unreadable, blank);

    for (const [path, slot] of taggedSlots(record)) {
      expect(slot.status, path).toBe('unavailable');
      expect(slot.value, path).toBeUndefined();
    }
    const figures = { proxy: record.proxy, journal: record.journal, deltas: record.deltas };
    expect(JSON.stringify(figures)).not.toContain(':0');
  });

  it('refuses a bare number where a tagged union belongs', () => {
    const smuggled = { ...proxyGolden('proxy-export-echoed.json'), requests: 0 } as unknown;

    expect(() => reconcileAccounting(smuggled as ProxyExport, journal()))
      .toThrow(AccountingInputError);
  });

  it('refuses an unavailable reason outside the closed set', () => {
    const golden = proxyGolden('proxy-export-echoed.json');
    const smuggled = {
      ...golden, cost_usd: { status: 'unavailable', reason: 'seemed_fine' },
    } as unknown;

    expect(() => reconcileAccounting(smuggled as ProxyExport, journal()))
      .toThrow(AccountingInputError);
  });

  it('refuses a negative cost, which neither side can honestly have observed', () => {
    const golden = proxyGolden('proxy-export-echoed.json');
    // The type system cannot tell a negative decimal string from a positive one, so the boundary
    // check is the thing that refuses it.
    const smuggled: ProxyExport = {
      ...golden, cost_usd: { status: 'available' as const, value: '-0.5' },
    };

    expect(() => reconcileAccounting(smuggled, journal())).toThrow(AccountingInputError);
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
        throw new Error(`the reconciliation touched the file system: ${String(property)}`);
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

    const record = module.reconcileAccounting(
      Object.freeze(proxyInput), Object.freeze(journalInput),
    );

    expect(record.reconciled).toEqual({ status: 'available', value: true });
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
    const record = reconcileAccounting(proxyGolden('proxy-export-echoed.json'), journal());

    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.proxy)).toBe(true);
    expect(Object.isFrozen(record.unaccounted_roles)).toBe(true);
  });
});

describe('R-A5-2 — an absent operand is neither a match nor a mismatch', () => {
  it('leaves reconciled unavailable, not false and not true', () => {
    const record = reconcileAccounting(
      proxyGolden('proxy-export-echoed.json'),
      journal({ cost_usd: { status: 'unavailable', reason: 'journal_underivable' } }),
    );

    expect(record.reconciled.status).toBe('unavailable');
    expect(record.reconciled).not.toEqual({ status: 'available', value: false });
    expect(record.reconciled).not.toEqual({ status: 'available', value: true });
    expect(record.reconciled).toEqual({
      status: 'unavailable', reason: 'operand_unavailable',
    });
    expect(checkIds(record)).toContain('accounting_operand_unavailable');
    expect(checkIds(record)).not.toContain('accounting_cost_out_of_tolerance');
  });

  it('raises the operand check rather than a comparison check', () => {
    const record = reconcileAccounting(
      proxyGolden('proxy-export-echoed.json'),
      journal({ cost_usd: { status: 'unavailable', reason: 'journal_underivable' } }),
    );

    expect(failedChecks(record).map(check => check.check_id))
      .toEqual(['accounting_operand_unavailable']);
    expect(record.deltas.cost_usd).toEqual({
      status: 'unavailable', reason: 'operand_unavailable',
    });
  });

  it('carries the existing terminal code rather than a new one', () => {
    const record = reconcileAccounting(
      proxyGolden('proxy-export-no-echo.json'),
      journal({ requests: { status: 'available', value: 2 },
        cost_usd: { status: 'available', value: '0.000102' } }),
    );
    const terminal = BENCHMARK_FAILURES.find(f => f.reason === 'terminal_predicate_unmet');

    expect(failedChecks(record).map(check => check.failure_code)).toEqual([terminal?.code]);
    expect(BENCHMARK_FAILURES.filter(f => f.code > 44)).toEqual([]);
  });
});

/**
 * The journal has no request counter to be absent, so `journal.requests` is permanently
 * `journal_underivable`. While it was an operand, every trial reconciled `unavailable`.
 */
describe('the requests axis is not an operand of reconciled', () => {
  const underivable = {
    requests: { status: 'unavailable', reason: 'journal_underivable' },
  } as const;

  it('reconciles a well-formed trial whose journal request count is underivable', () => {
    const record = reconcileAccounting(
      proxyGolden('proxy-export-echoed.json'), journal(underivable),
    );

    expect(record.reconciled).toEqual({ status: 'available', value: true });
    expect(failedChecks(record)).toEqual([]);
    expect(checkIds(record)).not.toContain('accounting_operand_unavailable');
  });

  it('names no missing operand for the requests axis', () => {
    const record = reconcileAccounting(
      proxyGolden('proxy-export-echoed.json'), journal(underivable),
    );

    expect(JSON.stringify(record.checks)).not.toContain('journal.requests');
  });

  // The delta and the mismatch check id are retained, not removed: a reader must be able to see
  // that the axis went unevaluated rather than infer it from an absence.
  it('keeps the requests delta unavailable and constructs no mismatch check', () => {
    const record = reconcileAccounting(
      proxyGolden('proxy-export-echoed.json'), journal(underivable),
    );

    expect(record.deltas.requests).toEqual({
      status: 'unavailable', reason: 'operand_unavailable',
    });
    expect(checkIds(record)).not.toContain('accounting_requests_mismatch');
  });

  it('lists no unaccounted role when the journal side cannot be counted', () => {
    const record = reconcileAccounting(
      proxyGolden('proxy-export-echoed.json'), journal(underivable),
    );

    expect(record.unaccounted_roles).toEqual([]);
  });
});

/**
 * `OPERAND_PATHS` and the slots array it filters are positionally coupled, so an edit to one and
 * not the other shifts every later index silently. Each operand is knocked out alone and must be
 * named by its own path — a shift renames the reported operand and fails here.
 */
describe('the operand list and its slots stay positionally aligned', () => {
  const unreadable = { status: 'unavailable', reason: 'counter_unreadable' } as const;

  const cases: [string, () => ReturnType<typeof reconcileAccounting>][] = [
    ['proxy.requests', () => reconcileAccounting(
      { ...proxyGolden('proxy-export-echoed.json'), requests: unreadable }, journal(),
    )],
    ['proxy.cost_usd', () => reconcileAccounting(
      { ...proxyGolden('proxy-export-echoed.json'), cost_usd: unreadable }, journal(),
    )],
    ['proxy.lease_echo', () => reconcileAccounting(
      { ...proxyGolden('proxy-export-echoed.json'), lease_echo: unreadable }, journal(),
    )],
    ['journal.cost_usd', () => reconcileAccounting(
      proxyGolden('proxy-export-echoed.json'), journal({ cost_usd: unreadable }),
    )],
  ];

  for (const [path, build] of cases) {
    it(`names exactly ${path} when only that operand is unavailable`, () => {
      const record = build();

      const operand = failedChecks(record)
        .find(entry => entry.check_id === 'accounting_operand_unavailable');
      expect(operand?.detail).toBe(path);
    });
  }

  it('fails closed on every proxy operand, each still reaching reconciled unavailable', () => {
    for (const [path, build] of cases) {
      const record = build();

      expect(record.reconciled, path).toEqual({
        status: 'unavailable', reason: 'operand_unavailable',
      });
      expect(failedChecks(record).map(check => check.check_id), path)
        .toContain('accounting_operand_unavailable');
    }
  });
});

describe('R-A5-3 — costs are decimal strings on both sides', () => {
  it('survives a value a binary float would corrupt', () => {
    const exact = '9007199254740993.0000001';
    const golden = proxyGolden('proxy-export-echoed.json');
    const record = reconcileAccounting(
      { ...golden, cost_usd: { status: 'available', value: exact } },
      journal({ cost_usd: { status: 'available', value: exact } }),
    );

    expect(record.proxy.cost_usd).toEqual({ status: 'available', value: exact });
    expect(String(Number(exact))).not.toBe(exact);
    expect(record.deltas.cost_usd).toEqual({ status: 'available', value: '0' });
  });

  it('subtracts without binary-float drift', () => {
    const golden = proxyGolden('proxy-export-echoed.json');
    const record = reconcileAccounting(
      { ...golden, cost_usd: { status: 'available', value: '0.3' } },
      journal({ cost_usd: { status: 'available', value: '0.1' } }),
    );

    expect(record.deltas.cost_usd).toEqual({ status: 'available', value: '0.2' });
    expect(String(0.3 - 0.1)).toBe('0.19999999999999998');
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

describe('A3 — the tolerance rule', () => {
  it('records the tolerance it applied', () => {
    const record = reconcileAccounting(proxyGolden('proxy-export-echoed.json'), journal());

    expect(record.tolerance).toEqual({
      requests_abs: 0, cost_usd_rel: '0.01', cost_usd_abs_floor: '0.000001',
    });
    expect(record.tolerance).toEqual(DEFAULT_ACCOUNTING_TOLERANCE);
  });

  it('raises a request mismatch on a single-request difference', () => {
    const record = reconcileAccounting(
      proxyGolden('proxy-export-echoed.json'),
      journal({ requests: { status: 'available', value: 4 } }),
    );

    expect(failedChecks(record).map(check => check.check_id))
      .toEqual(['accounting_requests_mismatch']);
    expect(record.deltas.requests).toEqual({ status: 'available', value: -1 });
    expect(record.reconciled).toEqual({ status: 'available', value: false });
  });

  it('reconciles a cost difference inside the tolerance', () => {
    const record = reconcileAccounting(
      proxyGolden('proxy-export-echoed.json'),
      journal({ cost_usd: { status: 'available', value: '0.000152' } }),
    );

    expect(failedChecks(record)).toEqual([]);
    expect(record.reconciled).toEqual({ status: 'available', value: true });
  });

  it('raises a cost check outside the tolerance', () => {
    const golden = proxyGolden('proxy-export-echoed.json');
    const record = reconcileAccounting(
      { ...golden, cost_usd: { status: 'available', value: '10' } },
      journal({ cost_usd: { status: 'available', value: '9.5' } }),
    );

    expect(failedChecks(record).map(check => check.check_id))
      .toEqual(['accounting_cost_out_of_tolerance']);
    expect(record.deltas.cost_usd).toEqual({ status: 'available', value: '0.5' });
  });

  it('applies the absolute floor rather than a ratio on a near-zero trial', () => {
    const golden = proxyGolden('proxy-export-echoed.json');
    const record = reconcileAccounting(
      { ...golden, cost_usd: { status: 'available', value: '0.0000000001' } },
      journal({ cost_usd: { status: 'available', value: '0.0000005' } }),
    );

    expect(failedChecks(record)).toEqual([]);
  });

  it('refuses a request tolerance widened away from exact equality', () => {
    const widened = { ...DEFAULT_ACCOUNTING_TOLERANCE, requests_abs: 1 } as unknown;

    expect(() => reconcileAccounting(
      proxyGolden('proxy-export-echoed.json'), journal(), widened as AccountingTolerance,
    )).toThrow(AccountingInputError);
  });

  it('refuses a negative cost tolerance', () => {
    const inverted = { ...DEFAULT_ACCOUNTING_TOLERANCE, cost_usd_rel: '-0.5' } as unknown;

    expect(() => reconcileAccounting(
      proxyGolden('proxy-export-echoed.json'), journal(), inverted as AccountingTolerance,
    )).toThrow(AccountingInputError);
  });
});

describe('A4 — a role the DAG never recorded is listed, not absorbed', () => {
  it('lists the proxy excess instead of widening the comparison', () => {
    const record = reconcileAccounting(
      proxyGolden('proxy-export-echoed.json'),
      journal({
        requests: { status: 'available', value: 1 },
        cost_usd: { status: 'available', value: '0.000051' },
        roles: ['parent'],
      }),
    );

    expect(record.unaccounted_roles).toEqual([{
      kind: 'proxy_excess',
      journal_roles: ['parent'],
      requests: { status: 'available', value: 2 },
      cost_usd: { status: 'available', value: '0.000102' },
    }]);
    expect(failedChecks(record).map(check => check.check_id))
      .toEqual(['accounting_requests_mismatch', 'accounting_cost_out_of_tolerance']);
    expect(record.reconciled).toEqual({ status: 'available', value: false });
  });

  it('lists nothing when the journal accounts for every request', () => {
    const record = reconcileAccounting(proxyGolden('proxy-export-echoed.json'), journal());

    expect(record.unaccounted_roles).toEqual([]);
  });

  it('lists nothing when the journal claims more than the proxy saw', () => {
    const record = reconcileAccounting(
      proxyGolden('proxy-export-echoed.json'),
      journal({ requests: { status: 'available', value: 5 } }),
    );

    expect(record.unaccounted_roles).toEqual([]);
    expect(failedChecks(record).map(check => check.check_id))
      .toEqual(['accounting_requests_mismatch']);
  });
});

describe('the cross-language seam', () => {
  it('reconciles the bytes the Python export actually emitted', () => {
    const golden = proxyGolden('proxy-export-echoed.json');

    const record = reconcileAccounting(golden, journal());

    expect(record.proxy.requests).toEqual({ status: 'available', value: 3 });
    expect(record.proxy.cost_usd).toEqual({ status: 'available', value: '0.000153' });
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
    expect(record.reconciled).toEqual({ status: 'available', value: true });
    expect(failedChecks(record)).toEqual([]);
  });

  it('carries the no-echo trial through as an unavailable operand', () => {
    const golden = proxyGolden('proxy-export-no-echo.json');

    const record = reconcileAccounting(golden, journal({
      requests: { status: 'available', value: 2 },
      cost_usd: { status: 'available', value: '0.000102' },
      tokens: {
        input: { status: 'available', value: 4 },
        output: { status: 'available', value: 6 },
        cached: { status: 'available', value: 0 },
      },
    }));

    expect(record.proxy.lease_echo).toEqual({
      status: 'unavailable', reason: 'no_echo_received',
    });
    expect(record.reconciled).toEqual({
      status: 'unavailable', reason: 'operand_unavailable',
    });
    expect(failedChecks(record).map(check => check.check_id))
      .toEqual(['accounting_operand_unavailable']);
    expect(failedChecks(record)[0].detail).toContain('proxy.lease_echo');
  });
});
