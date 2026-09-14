// input:  executions about to be archived out of executions.json
// output: sessionTotalsCarry — per-session roll-up of records the live registry no longer holds,
//         plus the watermark that keeps carry and live an exact partition
// pos:    Session-totals persistence layer (data/session-totals.json)

import * as path from 'path';
import { JsonRepository } from '@core/json-repository.js';
import { STORE_DIR } from '@core/paths.js';
import {
  addTotalsAcc, emptyTotalsAcc, foldExecution,
  type ExecutionLike, type SessionTotalsAcc,
} from './session-totals.js';

/**
 * Why this file exists at all: `executionRepo.archiveTerminal` moves week-old terminal records to
 * `archive/executions-archive.jsonl` and DELETES them from the live map. Summing the live registry
 * alone would therefore make a session quietly lose a week-old run — a long commission would
 * under-report its own cost forever, with nothing on screen to hint at it.
 *
 * Exactly-once without a transaction, via `carriedThrough`:
 *
 *   carry  = every run that ended BEFORE the watermark
 *   live   = every run that ended AT or after it
 *
 * The fold and the watermark advance are one atomic write, and the query skips live records older
 * than the watermark. So a crash anywhere in the archive sweep is still correct: crash before the
 * fold leaves the watermark behind and the records counted live; crash after the fold but before
 * the registry delete lands leaves them in the registry, where the watermark now excludes them.
 */
export interface SessionTotalsCarryData {
  /** ISO instant; every run that ended strictly before it is already inside `sessions`. Null until
   *  the first archive sweep — i.e. on every install that has never archived anything. */
  carriedThrough: string | null;
  sessions: Record<string, SessionTotalsAcc>;
}

function carryFile(): string {
  return process.env.CORTEX_SESSION_TOTALS_FILE || path.join(STORE_DIR, 'session-totals.json');
}

function numberField(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Drop anything that is not a complete numeric accumulator rather than trusting it partially:
 *  a half-written entry would otherwise add NaN into a number rendered as money. */
function migrate(raw: unknown): SessionTotalsCarryData {
  const empty: SessionTotalsCarryData = { carriedThrough: null, sessions: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const top = raw as Record<string, unknown>;
  const carriedThrough = typeof top.carriedThrough === 'string' && top.carriedThrough
    ? top.carriedThrough
    : null;
  const rawSessions = top.sessions;
  if (!rawSessions || typeof rawSessions !== 'object' || Array.isArray(rawSessions)) {
    return { carriedThrough, sessions: {} };
  }
  const sessions: Record<string, SessionTotalsAcc> = {};
  for (const [id, value] of Object.entries(rawSessions as Record<string, unknown>)) {
    if (!id || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    sessions[id] = {
      runs: numberField(row, 'runs'),
      turns: numberField(row, 'turns'),
      activeMs: numberField(row, 'activeMs'),
      cost: numberField(row, 'cost'),
      costSamples: numberField(row, 'costSamples'),
      subCost: numberField(row, 'subCost'),
      subSamples: numberField(row, 'subSamples'),
    };
  }
  return { carriedThrough, sessions };
}

class SessionTotalsCarryRepo {
  private readonly repo: JsonRepository<SessionTotalsCarryData>;

  constructor(filePath?: string) {
    this.repo = new JsonRepository<SessionTotalsCarryData>({
      filePath: filePath || carryFile(),
      defaultValue: () => ({ carriedThrough: null, sessions: {} }),
      migrate,
    });
  }

  /** The carried totals + watermark. Cached after the first read (JsonRepository), so the
   *  sessions-list hot path pays one file read per process. */
  async read(): Promise<SessionTotalsCarryData> {
    return this.repo.read();
  }

  /**
   * Fold records that are LEAVING the live registry and advance the watermark to `carriedThrough`
   * in the same atomic write. The watermark only ever moves forward — a sweep run with an older
   * cutoff must not re-open a window that is already carried.
   */
  async fold(records: ExecutionLike[], carriedThrough: string): Promise<void> {
    if (records.length === 0) return;
    const batch = new Map<string, SessionTotalsAcc>();
    for (const record of records) foldExecution(batch, record);
    await this.repo.mutate((cur) => {
      const sessions: Record<string, SessionTotalsAcc> = { ...cur.sessions };
      for (const [sessionId, acc] of batch) {
        sessions[sessionId] = addTotalsAcc({ ...(sessions[sessionId] ?? emptyTotalsAcc()) }, acc);
      }
      const watermark = !cur.carriedThrough || cur.carriedThrough < carriedThrough
        ? carriedThrough
        : cur.carriedThrough;
      return { next: { carriedThrough: watermark, sessions }, result: undefined };
    });
  }

  /** Drop deleted sessions' carry so the file cannot outlive its sessions. Reads before mutating:
   *  the retention sweep calls this for every deleted session, and almost none of them are carried
   *  — `mutate` always writes, so an unconditional call would rewrite the file for nothing. */
  async forget(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const current = await this.repo.read();
    if (!sessionIds.some((id) => id in current.sessions)) return;
    await this.repo.mutate((cur) => {
      const sessions = { ...cur.sessions };
      for (const id of sessionIds) delete sessions[id];
      return { next: { ...cur, sessions }, result: undefined };
    });
  }

  async flush(): Promise<void> {
    await this.repo.flush();
  }

  /** Test seam: forget the cached value so a fixture written straight to disk is picked up. */
  invalidate(): void {
    this.repo.invalidate();
  }
}

export const sessionTotalsCarry = new SessionTotalsCarryRepo();
export { SessionTotalsCarryRepo };
