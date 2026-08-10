// input:  shipped ledger path, atomic write, failure registry, the §8.2 actor capability
// output: fail-closed P6 ledger port and supersession writer, bound to the sole ActorCapability
// pos:    In-trial acceptance ledger over the product ledger file; S-B token reconciliation
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { readFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import { atomicWriteSync } from '@core/atomic-write.js';
import { ledgerPath } from '../tasks/acceptance-ledger.js';
import { PolicyCompilationError } from './resolved-policy.js';
import type { ActorCapability } from './capabilities.js';

// The shapes below keep the ledger independent of the broader composite runtime module.
// CONFORMANCE IS ENFORCED AT THE WIRING POINT: `composite-runtime-ports.ts`'s
// `createAcceptanceLedgerPort` returns the frozen `TrialAcceptanceLedger`, and tsc checks
// assignability there (and in the test, which pins the local factory against the frozen interface
// from outside the src/ scope). Every capability
// parameter is the SOLE §8.2 `ActorCapability` (capabilities.ts) — the pre-integration
// `BenchmarkBrokerCapability` seam is gone from this tree, and a second token type anywhere is
// the abstraction split the gate exists to prevent.

/** §7.2 P6's closed verdict union, re-declared here because the interface module cannot be
 *  imported (see above). Compile-time pinned to the interface by the wiring point's return type
 *  and by the conformance test. */
export type AcceptanceVerdict = 'accepted' | 'rejected' | 'pending' | 'superseded';

/** The port's entry view — the frozen `AcceptanceLedgerEntry`, structurally identical. */
export type AcceptanceDeliveryKind = 'completed' | 'blocked';

export interface AcceptanceLedgerEntry {
  childId: string;
  kind: AcceptanceDeliveryKind;
  verdict: AcceptanceVerdict;
  note?: string | null;
  reworkRound: number;
  replacementId?: string | null;
}

export interface AcceptanceLedgerView {
  project: string;
  taskId: string;
  entries: readonly AcceptanceLedgerEntry[];
}

export interface TrialAcceptanceLedger {
  read(project: string, taskId: string): AcceptanceLedgerView;
  recordDelivered(
    capability: ActorCapability, childId: string, kind: AcceptanceDeliveryKind,
  ): boolean;
  recordVerdict(
    capability: ActorCapability, childId: string,
    verdict: AcceptanceVerdict, note: string,
  ): void;
  recordSuperseded(
    capability: ActorCapability, childId: string, replacementId: string,
  ): void;
  pending(project: string, taskId: string): AcceptanceLedgerEntry[];
}

export const LEDGER_UNREADABLE = 'ledger_unreadable' as const;
/** §8.7 code 42, pinned to the registry by test — never a second copy. */
export const LEDGER_UNREADABLE_CODE = 42;

/** §8.4 R11 / §8.7 code 42. Rides the registry's PolicyCompilationError so `code`/`reason`/
 *  `failureClass` come from the one 1–44 table and cannot drift from it. */
export class LedgerError extends PolicyCompilationError {
  constructor(detail: string) {
    super(LEDGER_UNREADABLE, detail);
    this.name = 'LedgerError';
  }
}

/** The shipped wire entry — the exact member set `acceptance-ledger.ts` writes. `superseded_by`
 *  is the ONE member a pre-Gate-4 build did not write, so it is optional here and tolerated on
 *  read: a missing key means the file predates the field, and it maps to the view's
 *  `replacementId` as `undefined` rather than failing the read. */
interface WireEntry {
  child: string;
  kind: AcceptanceDeliveryKind;
  delivered_at: string;
  verdict: AcceptanceVerdict;
  verdict_at: string | null;
  verdict_note: string | null;
  rework_round: number;
  superseded_by?: string | null;
}

const VERDICTS: ReadonlySet<string> = new Set(['pending', 'accepted', 'rejected', 'superseded']);
const DELIVERY_KINDS: ReadonlySet<string> = new Set(['completed', 'blocked']);
const WIRE_ENTRY_KEYS = new Set([
  'child', 'kind', 'delivered_at', 'verdict', 'verdict_at', 'verdict_note',
  'rework_round', 'superseded_by',
]);
const REQUIRED_WIRE_ENTRY_KEYS = [...WIRE_ENTRY_KEYS].filter(key => key !== 'superseded_by');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVerdict(value: unknown): value is AcceptanceVerdict {
  return typeof value === 'string' && VERDICTS.has(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function hasExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key));
}

function isWireEntry(value: unknown): value is WireEntry {
  if (!isRecord(value) || !hasExactKeys(value, WIRE_ENTRY_KEYS)) return false;
  if (!REQUIRED_WIRE_ENTRY_KEYS.every(key => Object.hasOwn(value, key))) return false;
  return typeof value.child === 'string'
    && typeof value.kind === 'string' && DELIVERY_KINDS.has(value.kind)
    && typeof value.delivered_at === 'string'
    && isVerdict(value.verdict)
    && isNullableString(value.verdict_at)
    && isNullableString(value.verdict_note)
    && Number.isInteger(value.rework_round) && (value.rework_round as number) >= 0
    && (value.superseded_by === undefined || isNullableString(value.superseded_by));
}

function parseWireEntry(target: string, childId: string, value: unknown): WireEntry {
  if (!isWireEntry(value) || value.child !== childId) {
    throw new LedgerError(`${target}: entry ${childId} is malformed`);
  }
  return {
    child: value.child,
    kind: value.kind,
    delivered_at: value.delivered_at,
    verdict: value.verdict,
    verdict_at: value.verdict_at,
    verdict_note: value.verdict_note,
    rework_round: value.rework_round,
    ...(value.superseded_by === undefined ? {} : { superseded_by: value.superseded_by }),
  };
}

/** D-11 — the inversion of the shipped fail-open at `acceptance-ledger.ts:46-55`. A MISSING file
 *  is not a read error: it is a node with no deliveries yet, exactly as `readProposalStore` treats
 *  ENOENT. Every other unreadable state — read error, parse error, wrong top-level shape, an entry
 *  that is not an object, a verdict this build cannot interpret — raises code 42, because §9.4
 *  M-4's terminal predicate asserts ledger emptiness and an unreadable ledger would read as
 *  "nothing pending" and admit the grader. */
function readLedgerFile(project: string, taskId: string): Record<string, WireEntry> {
  const target = ledgerPath(project, taskId);
  let raw: string;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new LedgerError(`${target}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new LedgerError(`${target}: ${(error as Error).message}`);
  }
  const topLevelKeys = new Set(['parent', 'project', 'children']);
  if (!isRecord(parsed) || !hasExactKeys(parsed, topLevelKeys)
    || parsed.parent !== taskId || parsed.project !== project || !isRecord(parsed.children)) {
    throw new LedgerError(`${target}: not a ledger record`);
  }
  const children: Record<string, WireEntry> = Object.create(null) as Record<string, WireEntry>;
  for (const [childId, value] of Object.entries(parsed.children)) {
    children[childId] = parseWireEntry(target, childId, value);
  }
  return children;
}

function writeLedgerFile(
  project: string, taskId: string, children: Record<string, WireEntry>,
): void {
  const target = ledgerPath(project, taskId);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    atomicWriteSync(target, JSON.stringify({ parent: taskId, project, children }, null, 2));
  } catch (error) {
    throw new LedgerError(`${target}: ${(error as Error).message}`);
  }
}

function toView(childId: string, entry: WireEntry): AcceptanceLedgerEntry {
  const view: AcceptanceLedgerEntry = {
    childId: entry.child ?? childId,
    kind: entry.kind,
    verdict: entry.verdict,
    reworkRound: entry.rework_round,
  };
  if (entry.verdict_note !== undefined) view.note = entry.verdict_note;
  if (entry.superseded_by !== undefined) view.replacementId = entry.superseded_by;
  return view;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

/** The port is bound to one (project, task node) at construction: the frozen interface's
 *  storage methods carry no project/taskId, so the coordinator constructs one ledger per manager
 *  task node (§7.1 I1) and `read`/`pending` take their key from their arguments. */
class TrialAcceptanceLedgerImpl implements TrialAcceptanceLedger {
  constructor(
    private readonly project: string,
    private readonly taskId: string,
    private readonly now: () => Date,
  ) {}

  read(project: string, taskId: string): AcceptanceLedgerView {
    const children = readLedgerFile(project, taskId);
    return {
      project,
      taskId,
      entries: Object.entries(children).map(([childId, entry]) => toView(childId, entry)),
    };
  }

  recordDelivered(
    _capability: ActorCapability, childId: string, kind: AcceptanceDeliveryKind,
  ): boolean {
    const children = readLedgerFile(this.project, this.taskId);
    const existing = children[childId];
    // The shipped dedupe, verbatim: only an accepted child never re-delivers; a rejected entry
    // re-opens to pending preserving its history (rework_round, note, superseded_by).
    if (existing?.verdict === 'accepted') return false;
    children[childId] = {
      child: childId,
      kind,
      delivered_at: nowIso(this.now),
      verdict: 'pending',
      verdict_at: null,
      verdict_note: existing?.verdict_note ?? null,
      rework_round: existing?.rework_round ?? 0,
      superseded_by: existing?.superseded_by ?? null,
    };
    writeLedgerFile(this.project, this.taskId, children);
    return true;
  }

  recordVerdict(
    _capability: ActorCapability, childId: string,
    verdict: AcceptanceVerdict, note: string,
  ): void {
    // §8.6's edge table gives each verdict its own writer: `verdict` is the manager's
    // acceptance/rejection (shipped pair), `superseded` has recordSuperseded (D-10) and `pending`
    // has recordDelivered. Letting them through here would let a caller write a `superseded` entry
    // without its superseded_by — a D-10 shape violation — so the two are refused (P1's
    // write-misuse TypeError, §1.5 rule 3).
    if (verdict !== 'accepted' && verdict !== 'rejected') {
      throw new TypeError(`recordVerdict accepts only 'accepted' | 'rejected', got '${verdict}'`);
    }
    const children = readLedgerFile(this.project, this.taskId);
    const existing = children[childId];
    const entry: WireEntry = existing ?? {
      child: childId,
      kind: 'completed',
      delivered_at: nowIso(this.now),
      verdict: 'pending',
      verdict_at: null,
      verdict_note: null,
      rework_round: 0,
      superseded_by: null,
    };
    entry.verdict = verdict;
    entry.verdict_at = nowIso(this.now);
    entry.verdict_note = note ?? entry.verdict_note ?? null;
    if (verdict === 'rejected') entry.rework_round += 1;
    children[childId] = entry;
    writeLedgerFile(this.project, this.taskId, children);
  }

  /** D-10 — the production writer for the fourth verdict. The replacement child id lands in the
   *  shipped `superseded_by` member, so the product reader sees the same record. History
   *  (rework_round, note) is preserved, as rework's own record does. */
  recordSuperseded(
    _capability: ActorCapability, childId: string, replacementId: string,
  ): void {
    const children = readLedgerFile(this.project, this.taskId);
    const existing = children[childId];
    const entry: WireEntry = existing ?? {
      child: childId,
      kind: 'completed',
      delivered_at: nowIso(this.now),
      verdict: 'pending',
      verdict_at: null,
      verdict_note: null,
      rework_round: 0,
      superseded_by: null,
    };
    entry.verdict = 'superseded';
    entry.verdict_at = nowIso(this.now);
    entry.superseded_by = replacementId;
    children[childId] = entry;
    writeLedgerFile(this.project, this.taskId, children);
  }

  pending(project: string, taskId: string): AcceptanceLedgerEntry[] {
    return Object.entries(readLedgerFile(project, taskId))
      .map(([childId, entry]) => toView(childId, entry))
      .filter(entry => entry.verdict === 'pending');
  }
}

export interface TrialAcceptanceLedgerOptions {
  /** P17 seam: the deterministic clock's `now`. Defaults to the real clock. */
  readonly now?: () => Date;
}

/** One construction point (§7.1 I1): the coordinator builds one ledger port per (project, task
 *  node) it serves. */
export function createTrialAcceptanceLedger(
  project: string,
  taskId: string,
  options: TrialAcceptanceLedgerOptions = {},
): TrialAcceptanceLedger {
  return new TrialAcceptanceLedgerImpl(project, taskId, options.now ?? (() => new Date()));
}
