// input:  Vitest, a temp project node, the shipped acceptance ledger's file (ledgerPath)
// output: P6 fail-closed reads (D-11), the D-10 recordSuperseded writer, old-format compat,
//         production composition through the sole ActorCapability
// pos:    §7.2 P6 — the in-trial acceptance ledger port over the SAME file the daemon reads
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { PROJECTS_DIR } from '../../../src/core/paths.js';
import {
  ledgerPath, readLedger as productReadLedger,
} from '../../../src/domain/tasks/acceptance-ledger.js';
import {
  createTrialAcceptanceLedger,
  LEDGER_UNREADABLE, LEDGER_UNREADABLE_CODE, LedgerError,
} from '../../../src/domain/benchmark/trial-acceptance-ledger.js';
import {
  createAcceptanceLedgerPort,
} from '../../../src/domain/benchmark/composite-runtime-ports.js';
import { BENCHMARK_FAILURES } from '../../../src/domain/benchmark/resolved-policy.js';
import {
  mintActorCapability, type ActorCapability,
} from '../../../src/domain/benchmark/capabilities.js';
import {
  createActorCapabilityRegistry, requireAmbientCapability,
} from '../../../src/domain/benchmark/actor-capability-scope.js';
import { createLocalThreadRuntimeDeps } from '../../../src/domain/threads/local-runtime-defaults.js';
import { failClosedRuntimeDeps } from '../../../src/domain/threads/local-runtime-deps.js';
import { runThread } from '../../../src/domain/threads/runner.js';
import type {
  AcceptanceLedgerEntry, TrialAcceptanceLedger,
} from '../../../src/domain/benchmark/composite-runtime-ports.js';

let counter = 0;
let project = '';
const PARENT = 'p001';
const CHILD = 'c001';
const FIXED_NOW = new Date('2026-08-07T00:00:00.000Z');

/** A production-minted §8.2 ActorCapability — the SOLE token of the combined tree, minted by the
 *  shipped `mintActorCapability` (capabilities.ts). The ledger port performs no authorization —
 *  that is §8.3's broker matrix — so the token is accepted and unused, exactly as the shipped
 *  acceptance-ledger functions have no capability; what matters here is that the port's
 *  signatures carry the same S-B token every other capability-bearing port carries, never a
 *  second structural or action-union type. */
const CAP: ActorCapability = mintActorCapability({
  trial_id: 'trial-ledger',
  task_id: PARENT,
  dispatch_generation: 'gen-1',
  attempt_id: 'attempt-1',
  role: 'manager',
  ancestry: ['root'],
  capability_whitelist: [
    'task.read', 'task.create', 'task.decompose', 'task.claim', 'task.propose_complete',
    'task.propose_block', 'artifact.write', 'dependency.declare', 'qa.ask', 'qa.answer',
  ],
  issued_at_epoch_ms: 0,
});

function newPort(options?: { now?: () => Date }) {
  return createTrialAcceptanceLedger(project, PARENT, options);
}

function writeRawLedger(text: string): void {
  const target = ledgerPath(project, PARENT);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

/** The EXACT wire format a pre-Gate-4 build wrote: every shipped LedgerEntry field except
 *  `superseded_by`, which did not exist in its union or its writer. */
type OldWireEntry = {
  child: string;
  kind: string;
  delivered_at: string;
  verdict: string;
  verdict_at: string | null;
  verdict_note: string | null;
  rework_round: number;
};

function writeOldFormatLedger(children: Record<string, OldWireEntry>): void {
  writeRawLedger(JSON.stringify({ parent: PARENT, project, children }, null, 2));
}

function oldEntry(verdict: string, reworkRound = 0, child = CHILD): OldWireEntry {
  return {
    child,
    kind: 'completed',
    delivered_at: '2026-08-06T00:00:00.000Z',
    verdict,
    verdict_at: '2026-08-06T00:00:01.000Z',
    verdict_note: null,
    rework_round: reworkRound,
  };
}

beforeEach(() => {
  project = `_test_trial_ledger_${++counter}`;
  fs.mkdirSync(path.join(PROJECTS_DIR, project), { recursive: true });
});

describe('§7.2 P6 — read fails CLOSED (D-11)', () => {
  it('a missing ledger reads as an EMPTY ledger — a fresh node has no file yet', () => {
    const view = newPort().read(project, PARENT);
    assert.deepEqual(view.entries, []);
    assert.equal(view.project, project);
    assert.equal(view.taskId, PARENT);
  });

  it('a corrupt file raises ledger_unreadable, asserted by CODE and IDENTIFIER, never by message', () => {
    writeRawLedger('not json at all');
    let caught: unknown;
    try {
      newPort().read(project, PARENT);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof LedgerError, `expected LedgerError, got ${String(caught)}`);
    const error = caught as LedgerError;
    assert.equal(error.reason, LEDGER_UNREADABLE);
    assert.equal(error.code, LEDGER_UNREADABLE_CODE);
    assert.equal(error.failureClass, 'R');
    // the code rides the §8.7 registry — one 1-44 table, no second copy
    const registered = BENCHMARK_FAILURES.find(f => f.reason === LEDGER_UNREADABLE);
    assert.ok(registered, 'ledger_unreadable must exist in the 1-44 registry');
    assert.equal(LEDGER_UNREADABLE_CODE, registered.code);
    assert.equal(registered.failureClass, 'R');
  });

  it('an unreadable path (a directory at the ledger path) raises ledger_unreadable', () => {
    fs.mkdirSync(ledgerPath(project, PARENT), { recursive: true });
    assert.throws(() => newPort().read(project, PARENT), error =>
      error instanceof LedgerError && error.code === LEDGER_UNREADABLE_CODE);
  });

  it('a shape-corrupt file raises ledger_unreadable — every shipped empty-ledger branch', () => {
    const validEntry = oldEntry('pending');
    const corruptBodies = [
      '[]',
      '"a string"',
      '42',
      JSON.stringify({ parent: PARENT, project }),
      JSON.stringify({ parent: PARENT, project, children: null }),
      JSON.stringify({ parent: PARENT, project, children: [] }),
      JSON.stringify({ parent: PARENT, project, children: { [CHILD]: 42 } }),
      JSON.stringify({ parent: PARENT, project, children: { [CHILD]: { verdict: 'maybe' } } }),
      JSON.stringify({ parent: PARENT, project, children: { [CHILD]: { verdict: 'pending' } } }),
      JSON.stringify({ parent: PARENT, project,
        children: { [CHILD]: { verdict: 'pending', kind: 'completed' } } }),
      JSON.stringify({ parent: PARENT, project,
        children: { [CHILD]: { ...validEntry, child: 42 } } }),
      JSON.stringify({ parent: PARENT, project,
        children: { [CHILD]: { ...validEntry, delivered_at: 42 } } }),
      JSON.stringify({ parent: PARENT, project,
        children: { [CHILD]: { ...validEntry, verdict_at: 42 } } }),
      JSON.stringify({ parent: PARENT, project,
        children: { [CHILD]: { ...validEntry, verdict_note: 42 } } }),
      JSON.stringify({ parent: 'wrong-parent', project, children: { [CHILD]: validEntry } }),
      JSON.stringify({ parent: PARENT, project: 'wrong-project', children: { [CHILD]: validEntry } }),
      JSON.stringify({ parent: PARENT, project, children: { [CHILD]: validEntry }, extra: true }),
      JSON.stringify({ parent: PARENT, project,
        children: { [CHILD]: { ...validEntry, kind: 'unknown' } } }),
      JSON.stringify({ parent: PARENT, project,
        children: { [CHILD]: { ...validEntry, child: 'wrong-child' } } }),
      JSON.stringify({ parent: PARENT, project,
        children: { [CHILD]: { ...validEntry, rework_round: -1 } } }),
      JSON.stringify({ parent: PARENT, project,
        children: { [CHILD]: { ...validEntry, rework_round: 1.5 } } }),
      JSON.stringify({ parent: PARENT, project,
        children: { [CHILD]: { ...validEntry, superseded_by: 42 } } }),
      JSON.stringify({ parent: PARENT, project,
        children: { [CHILD]: { ...validEntry, extra: true } } }),
    ];
    for (const body of corruptBodies) {
      writeRawLedger(body);
      assert.throws(() => newPort().read(project, PARENT), error =>
        error instanceof LedgerError && error.code === LEDGER_UNREADABLE_CODE,
        `expected code 42 for: ${body}`);
    }
  });

  it('H-10 — the SAME corrupt file still degrades fail-open on the product path', () => {
    writeRawLedger('not json at all');
    assert.deepEqual(productReadLedger(project, PARENT), {
      parent: PARENT, project, children: {},
    });
    assert.throws(() => newPort().read(project, PARENT),
      error => error instanceof LedgerError && error.code === 42);
  });
});

describe('P6 — delivery and verdict semantics mirror the shipped module', () => {
  it('recordDelivered writes a pending entry the PRODUCT reader also sees', () => {
    const port = newPort();
    assert.equal(port.recordDelivered(CAP, CHILD, 'completed'), true);
    const view = port.read(project, PARENT);
    assert.equal(view.entries.length, 1);
    assert.equal(view.entries[0]!.childId, CHILD);
    assert.equal(view.entries[0]!.verdict, 'pending');
    assert.equal(view.entries[0]!.reworkRound, 0);
    const shipped = productReadLedger(project, PARENT).children[CHILD]!;
    assert.equal(shipped.verdict, 'pending');
    assert.equal(shipped.superseded_by, null);
  });

  it('recordDelivered refuses an already-accepted child (cross-incarnation dedupe)', () => {
    const port = newPort();
    assert.equal(port.recordDelivered(CAP, CHILD, 'completed'), true);
    port.recordVerdict(CAP, CHILD, 'accepted', 'good');
    assert.equal(port.recordDelivered(CAP, CHILD, 'completed'), false);
    assert.equal(port.read(project, PARENT).entries[0]!.verdict, 'accepted');
  });

  it('recordDelivered re-opens a rejected child preserving rework_round and note', () => {
    const port = newPort();
    assert.equal(port.recordDelivered(CAP, CHILD, 'completed'), true);
    port.recordVerdict(CAP, CHILD, 'rejected', 'again');
    assert.equal(port.recordDelivered(CAP, CHILD, 'blocked'), true);
    const reopened = port.read(project, PARENT).entries[0]!;
    assert.equal(reopened.verdict, 'pending');
    assert.equal(reopened.reworkRound, 1);
    assert.equal(reopened.note, 'again');
  });

  it('recordVerdict upserts a missing entry and stamps verdict_at and note', () => {
    const port = newPort({ now: () => FIXED_NOW });
    port.recordVerdict(CAP, 'c-absent', 'accepted', 'direct');
    const entry = port.read(project, PARENT).entries[0]!;
    assert.equal(entry.childId, 'c-absent');
    assert.equal(entry.verdict, 'accepted');
    assert.equal(entry.note, 'direct');
    assert.equal(productReadLedger(project, PARENT).children['c-absent']!.verdict_at,
      FIXED_NOW.toISOString());
  });

  it('recordVerdict increments rework_round on every rejection', () => {
    const port = newPort();
    port.recordDelivered(CAP, CHILD, 'completed');
    port.recordVerdict(CAP, CHILD, 'rejected', 'r1');
    port.recordVerdict(CAP, CHILD, 'rejected', 'r2');
    assert.equal(port.read(project, PARENT).entries[0]!.reworkRound, 2);
  });

  it('recordVerdict refuses the two verdicts that have their own writers', () => {
    const port = newPort();
    port.recordDelivered(CAP, CHILD, 'completed');
    assert.throws(() => port.recordVerdict(CAP, CHILD, 'superseded', 'x'), TypeError);
    assert.throws(() => port.recordVerdict(CAP, CHILD, 'pending', 'x'), TypeError);
    assert.equal(port.read(project, PARENT).entries[0]!.verdict, 'pending');
  });
});

describe('D-10 — recordSuperseded is the production writer', () => {
  it('writes the superseded verdict with the replacement id, readable by BOTH readers', () => {
    const port = newPort();
    port.recordDelivered(CAP, CHILD, 'completed');
    port.recordSuperseded(CAP, CHILD, 'c002');
    const entry = port.read(project, PARENT).entries[0]!;
    assert.equal(entry.verdict, 'superseded');
    assert.equal(entry.replacementId, 'c002');
    const shipped = productReadLedger(project, PARENT).children[CHILD]!;
    assert.equal(shipped.verdict, 'superseded');
    assert.equal(shipped.superseded_by, 'c002');
    // §9.4 M-4 counts `pending`: a superseded child is not outstanding
    assert.deepEqual(port.pending(project, PARENT), []);
  });

  it('stamps verdict_at from the injected clock (P17 seam)', () => {
    const port = newPort({ now: () => FIXED_NOW });
    port.recordSuperseded(CAP, CHILD, 'c002');
    const shipped = productReadLedger(project, PARENT).children[CHILD]!;
    assert.equal(shipped.verdict_at, FIXED_NOW.toISOString());
    assert.equal(shipped.delivered_at, FIXED_NOW.toISOString());
  });

  it('preserves the entry history: rework_round and note survive the supersession', () => {
    const port = newPort();
    port.recordDelivered(CAP, CHILD, 'completed');
    port.recordVerdict(CAP, CHILD, 'rejected', 'needs rerun');
    port.recordSuperseded(CAP, CHILD, 'c002');
    const entry = port.read(project, PARENT).entries[0]!;
    assert.equal(entry.reworkRound, 1);
    assert.equal(entry.note, 'needs rerun');
  });

  it('upserts a never-delivered child', () => {
    const port = newPort();
    port.recordSuperseded(CAP, 'c-orphan', 'c002');
    assert.equal(port.read(project, PARENT).entries[0]!.verdict, 'superseded');
    assert.equal(productReadLedger(project, PARENT).children['c-orphan']!.superseded_by, 'c002');
  });
});

describe('backward compatibility — ledgers written before superseded_by existed', () => {
  it('an old-format ledger reads with replacementId undefined for every old verdict', () => {
    writeOldFormatLedger({
      pend: oldEntry('pending', 0, 'pend'),
      acc: oldEntry('accepted', 0, 'acc'),
      rej: oldEntry('rejected', 2, 'rej'),
    });
    const view = newPort().read(project, PARENT);
    assert.equal(view.entries.length, 3);
    for (const entry of view.entries) {
      assert.equal(entry.replacementId, undefined, `${entry.childId} must read undefined`);
    }
  });

  it('a pending entry from an old build stays deliverable and outstanding', () => {
    writeOldFormatLedger({ [CHILD]: oldEntry('pending') });
    const port = newPort();
    assert.deepEqual(port.pending(project, PARENT).map(e => e.childId), [CHILD]);
    assert.equal(port.recordDelivered(CAP, CHILD, 'completed'), true);
  });

  it('an accepted entry from an old build never re-delivers', () => {
    writeOldFormatLedger({ [CHILD]: oldEntry('accepted') });
    assert.equal(newPort().recordDelivered(CAP, CHILD, 'completed'), false);
  });

  it('a rejected entry from an old build re-opens preserving its rework_round', () => {
    writeOldFormatLedger({ [CHILD]: oldEntry('rejected', 2) });
    const port = newPort();
    // the old file reads with the field undefined…
    assert.equal(port.read(project, PARENT).entries[0]!.replacementId, undefined);
    assert.equal(port.recordDelivered(CAP, CHILD, 'completed'), true);
    const reopened = port.read(project, PARENT).entries[0]!;
    assert.equal(reopened.verdict, 'pending');
    assert.equal(reopened.reworkRound, 2);
    // …and the re-delivery heals the file into the D-10 invariant: the field is always present
    // from the first write on (the shipped `?? null` materialisation, pinned by the shipped suite)
    assert.equal(reopened.replacementId, null);
  });

  it('a hand-crafted superseded verdict without the field is tolerated, not rejected', () => {
    // An old build could never write this verdict (its union had three values), but a file that
    // does carry it must not take the trial down: it reads with replacementId undefined and is
    // not outstanding.
    writeOldFormatLedger({ [CHILD]: oldEntry('superseded') });
    const port = newPort();
    const entry = port.read(project, PARENT).entries[0]!;
    assert.equal(entry.verdict, 'superseded');
    assert.equal(entry.replacementId, undefined);
    assert.deepEqual(port.pending(project, PARENT), []);
  });
});

describe('the write path fails closed too (R11: "cannot be read or written")', () => {
  it('a write failure raises ledger_unreadable, never a silent loss', () => {
    const port = newPort();
    port.recordDelivered(CAP, CHILD, 'completed');
    const dir = path.dirname(ledgerPath(project, PARENT));
    fs.chmodSync(dir, 0o500);
    try {
      assert.throws(() => port.recordVerdict(CAP, CHILD, 'accepted', 'x'), error =>
        error instanceof LedgerError && error.code === LEDGER_UNREADABLE_CODE);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    // the failed write left the ledger readable and unchanged
    assert.equal(productReadLedger(project, PARENT).children[CHILD]!.verdict, 'pending');
  });
});

describe('production composition — the port rides the bundle a coordinator builds', () => {
  it('the wired factory consumes the production-minted capability resolved from its live scope', async () => {
    const daemonBundle = createLocalThreadRuntimeDeps(runThread);
    const bundle = failClosedRuntimeDeps({
      ...daemonBundle,
      acceptanceLedger: createAcceptanceLedgerPort(project, PARENT),
    });
    const registry = createActorCapabilityRegistry(CAP.trial_id);
    registry.register(CAP);
    await registry.runInScope(CAP, async () => {
      const resolved = requireAmbientCapability(registry);
      assert.equal(resolved, CAP);
      const port = bundle.acceptanceLedger;
      assert.equal(typeof port.recordSuperseded, 'function');
      port.recordDelivered(resolved, CHILD, 'completed');
      port.recordSuperseded(resolved, CHILD, 'c002');
      assert.equal(port.read(project, PARENT).entries[0]!.verdict, 'superseded');
      assert.equal(port.pending(project, PARENT).length, 0);
    });
    // the bundle's port writes the same file the product path reads
    assert.equal(productReadLedger(project, PARENT).children[CHILD]!.superseded_by, 'c002');
  });

  it('no test-only factory exists: the port types come from the frozen interface', () => {
    const port = createAcceptanceLedgerPort(project, PARENT);
    const entries: readonly AcceptanceLedgerEntry[] = port.read(project, PARENT).entries;
    assert.deepEqual(entries, []);
  });

  it('the local factory conforms to the frozen TrialAcceptanceLedger interface (tsc-pinned)', () => {
    // tests/ is outside the ^src/domain/benchmark/ subject of the X-rules, so this test can import
    // the frozen interface directly: the assignment fails tsc if the implementation's local shapes
    // — including the ActorCapability-typed capability parameters — drift from the interface the
    // coordinator compiles against.
    const port: TrialAcceptanceLedger = createTrialAcceptanceLedger(project, PARENT);
    assert.deepEqual(port.read(project, PARENT).entries, []);
  });

  it('every capability-bearing signature takes the production-minted ActorCapability', () => {
    // The seam kill: if P6's capability parameters regress to the old action-union
    // (BenchmarkBrokerCapability) or to a new structural token, the tsc-pinned conformance above
    // breaks AND passing the minted token here stops compiling. This runtime call pins that the
    // port accepts the S-B token the broker resolves (G5-W4.3).
    const port = newPort();
    port.recordDelivered(CAP, CHILD, 'completed');
    port.recordVerdict(CAP, CHILD, 'accepted', 'through the minted token');
    port.recordSuperseded(CAP, 'c-other', 'c-next');
    assert.equal(port.read(project, PARENT).entries[0]!.verdict, 'accepted');
  });
});
