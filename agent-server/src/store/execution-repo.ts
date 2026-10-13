import * as path from 'path';
import { readFileSync, statSync } from 'fs';
import { appendFile, mkdir } from 'fs/promises';
import { JsonRepository, registerFlushable } from '@core/json-repository.js';
import { createLogger } from '@core/log.js';
import { AsyncMutex } from '@core/async-mutex.js';
import { STORE_DIR } from '@core/paths.js';
import { sessionTotalsCarry } from './session-totals-repo.js';

const log = createLogger('execution-repo');

export interface DispatchInfo {
  taskId: string;
  taskHash: string | null;
  machine: string | null;
  scheduleTaskId: string | null;
  tmuxName: string | null;
  pid: string | null;
}


export interface ExecutionRecord {
  id: string;
  kind: string;
  status: string;
  channel: string | null;
  project: string;
  source: { trigger: string };
  backend: string;
  billingMode: string;
  /** The session this run IS. Null for runs that carry no track identity — Agent-tool children
   *  most of all (see `ownerSessionId`). */
  session: {
    sessionId: string | null;
    /** The session this run was spawned BY, when it is not that session itself. Set on
     *  Agent-tool children, whose `sessionId` must stay null (a child is not the session, and
     *  the last-run resolvers key on `sessionId` — see query/sessions.ts). Read only by the
     *  session-totals roll-up, which needs a child's spend to land on the conversation that
     *  paid for it. Absent on every record written before this field existed. */
    ownerSessionId?: string | null;
  };
  /** Legacy: set on records written by the retired thread runtime; never written now. */
  thread?: { threadId: string | null; agentSlotId: string | null } | null;
  /** Legacy: set on records written by the retired task dispatcher; never written now. */
  dispatch?: DispatchInfo | null;
  scheduleTaskId: string | null;
  runtime: { startedAt: string; updatedAt: string; endedAt: string | null };
  metrics: { costUsd: number | null; numTurns: number | null; durationS: number | null };
  text: { label: string | null; finalOutput: string | null; error: string | null };
}

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stale', 'cancelled']);

type ExecutionsData = Record<string, ExecutionRecord>;

/** Discard retired session names from legacy rows in memory, without migrating the file. */
function withoutLegacySessionName(record: ExecutionRecord): ExecutionRecord {
  if (!record.session) return record;
  const session = { ...record.session } as ExecutionRecord['session'] & { sessionName?: unknown };
  delete session.sessionName;
  return { ...record, session };
}

interface ExecutionRepoOptions {
  /** Optional file path override. Defaults to $CORTEX_EXECUTIONS_FILE or DATA_DIR/executions.json */
  filePath?: string;
  /** Where archived records' numbers are preserved. Injectable so a test can archive into its own
   *  carry file instead of the process-wide one. Defaults to the `sessionTotalsCarry` singleton. */
  sessionTotals?: Pick<typeof sessionTotalsCarry, 'fold'>;
}

function getExecutionsFile(override?: string): string {
  return override || process.env.CORTEX_EXECUTIONS_FILE || path.join(STORE_DIR, 'executions.json');
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildExecutionId(kind: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `exec_${kind}_${stamp}_${rand}`;
}

function createBaseRecord({ kind, channel, project, trigger, backend, billingMode, sessionId, ownerSessionId, label, scheduleTaskId }: {
  kind: string; channel?: string | null; project?: string; trigger?: string;
  backend?: string; billingMode?: string; sessionId?: string | null; ownerSessionId?: string | null;
  label?: string | null; scheduleTaskId?: string | null;
}): ExecutionRecord {
  const timestamp = nowIso();
  return {
    id: buildExecutionId(kind),
    kind,
    status: 'running',
    channel: channel || null,
    project: project || 'general',
    source: { trigger: trigger || kind },
    backend: backend || 'claude',
    billingMode: billingMode || 'api',
    session: { sessionId: sessionId || null, ...(ownerSessionId ? { ownerSessionId } : {}) },
    scheduleTaskId: scheduleTaskId || null,
    runtime: {
      startedAt: timestamp,
      updatedAt: timestamp,
      endedAt: null,
    },
    metrics: {
      costUsd: null,
      numTurns: null,
      durationS: null,
    },
    text: {
      label: label || null,
      finalOutput: null,
      error: null,
    },
  };
}

function finalizeExecution(record: ExecutionRecord, status: string, { costUsd, numTurns, durationS, finalOutput, error }: {
  costUsd?: number | null; numTurns?: number | null; durationS?: number | null;
  finalOutput?: string | null; error?: string | null;
} = {}): ExecutionRecord {
  const timestamp = nowIso();
  return {
    ...record,
    status,
    runtime: {
      ...record.runtime,
      updatedAt: timestamp,
      endedAt: timestamp,
    },
    metrics: {
      costUsd: costUsd ?? record.metrics.costUsd,
      numTurns: numTurns ?? record.metrics.numTurns,
      durationS: durationS ?? record.metrics.durationS,
    },
    text: {
      ...record.text,
      finalOutput: finalOutput ?? record.text.finalOutput,
      error: error ?? record.text.error,
    },
  };
}

class ExecutionRepo {
  /** In-memory source of truth for all execution records. All sync reads come from here. */
  private map = new Map<string, ExecutionRecord>();
  private repo: JsonRepository<ExecutionsData>;

  public readonly filePath: string;
  /** Archive-time destination for the numbers of records this repo is about to forget. */
  private readonly sessionTotals: Pick<typeof sessionTotalsCarry, 'fold'>;

  private mutex = new AsyncMutex();
  /** Promise chain for fire-and-forget persists, guarded by this.mutex. */
  private _pendingPersist: Promise<void> = Promise.resolve();
  /** True while a persist is queued but not yet snapshotting — lets queuePersist coalesce. */
  private _persistQueued = false;
  /** Set by {@link follow}: identifies the file version the map holds, null when not following. */
  private followed: string | null = null;

  constructor(opts?: ExecutionRepoOptions) {
    this.filePath = getExecutionsFile(opts?.filePath);
    this.sessionTotals = opts?.sessionTotals ?? sessionTotalsCarry;
    this.repo = new JsonRepository<ExecutionsData>({
      filePath: this.filePath,
      defaultValue: () => ({}),
      compact: true, // multi-MB store: pretty-printing costs ~40% extra sync stringify per write
    });
  }

  // --- Lifecycle ---

  /** Load executions from disk into memory. Populates the Map from executions.json. */
  load(): void {
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf8'));
      this.map.clear();
      for (const [id, record] of Object.entries(data)) {
        this.map.set(id, withoutLegacySessionName(record as ExecutionRecord));
      }
      log.info(`Loaded ${this.map.size} executions`);
    } catch {
      this.map.clear();
    }
  }

  /**
   * Serve reads from the file as it is now, for a process that only reads executions (the stdio
   * MCP sidecar, whose session can outlive many runs). Every read re-loads the file when it changed
   * since the last one. The daemon owns and writes the file, so it never follows: a reload there
   * would drop whatever it still has queued to write.
   */
  follow(): void {
    this.followed = '';
    this.refresh();
  }

  /** Following only: re-read the file when its identity changed. An unreadable or half-written file
   *  keeps the last good snapshot and is retried on the next read. */
  private refresh(): void {
    if (this.followed === null) return;
    let version: string;
    try {
      const stat = statSync(this.filePath);
      version = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      this.map.clear();
      this.followed = 'missing';
      return;
    }
    if (version === this.followed) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf8')) as ExecutionsData;
      this.map = new Map(Object.entries(data).map(([id, record]) => [id, withoutLegacySessionName(record)]));
      this.followed = version;
    } catch (error) {
      log.warn(`Could not re-read ${this.filePath}: ${(error as Error).message}`);
    }
  }

  // --- Sync reads (fast path, no await) ---

  getExecution(id: string): ExecutionRecord | null {
    this.refresh();
    return this.map.get(id) || null;
  }

  getRunningExecutions(): ExecutionRecord[] {
    this.refresh();
    const results: ExecutionRecord[] = [];
    for (const record of this.map.values()) {
      if (record.status === 'running') results.push(record);
    }
    return results;
  }

  getAllExecutions(): ExecutionRecord[] {
    this.refresh();
    return Array.from(this.map.values());
  }

  getAll(): ExecutionRecord[] {
    this.refresh();
    return Array.from(this.map.values())
      .sort((a, b) => b.runtime.startedAt.localeCompare(a.runtime.startedAt));
  }

  // --- Sync create/mutate + fire-and-forget persist ---

  /** Internal: update a record in-place if not terminal, return updated or original. */
  private updateRecordInternal(id: string, updater: (record: ExecutionRecord) => ExecutionRecord): ExecutionRecord | null {
    const current = this.map.get(id);
    if (!current) return null;
    if (TERMINAL_STATUSES.has(current.status)) return current;
    const next = updater({ ...current });
    next.runtime = {
      ...current.runtime,
      ...next.runtime,
      updatedAt: nowIso(),
    };
    this.map.set(id, next);
    this.queuePersist();
    return next;
  }

  startLocalExecution({ kind = 'local', channel, project, trigger, backend, billingMode, sessionId, ownerSessionId = null, label, scheduleTaskId }: {
    kind?: string; channel?: string | null; project?: string; trigger?: string;
    backend?: string; billingMode?: string; sessionId?: string | null; ownerSessionId?: string | null;
    label?: string | null; scheduleTaskId?: string | null;
  }): ExecutionRecord {
    const record = createBaseRecord({ kind, channel, project, trigger, backend, billingMode, sessionId, ownerSessionId, label, scheduleTaskId });
    this.map.set(record.id, record);
    this.queuePersist();
    return record;
  }

  touchExecution(id: string, patch: {
    metrics?: Partial<ExecutionRecord['metrics']>;
    text?: Partial<ExecutionRecord['text']>;
    session?: Partial<ExecutionRecord['session']>;
    [key: string]: unknown;
  } = {}): ExecutionRecord | null {
    return this.updateRecordInternal(id, (record) => ({
      ...record,
      ...patch,
      metrics: { ...record.metrics, ...(patch.metrics || {}) },
      text: { ...record.text, ...(patch.text || {}) },
      session: patch.session ? { ...record.session, ...patch.session } : record.session,
    }));
  }

  completeExecution(id: string, metrics: { costUsd?: number | null; numTurns?: number | null; durationS?: number | null; finalOutput?: string | null; error?: string | null } = {}): ExecutionRecord | null {
    return this.updateRecordInternal(id, (record) => finalizeExecution(record, 'completed', metrics));
  }

  failExecution(id: string, metrics: { costUsd?: number | null; numTurns?: number | null; durationS?: number | null; finalOutput?: string | null; error?: string | null } = {}): ExecutionRecord | null {
    return this.updateRecordInternal(id, (record) => finalizeExecution(record, 'failed', metrics));
  }

  cancelExecution(id: string, metrics: { costUsd?: number | null; numTurns?: number | null; durationS?: number | null; finalOutput?: string | null; error?: string | null } = {}): ExecutionRecord | null {
    return this.updateRecordInternal(id, (record) => finalizeExecution(record, 'cancelled', metrics));
  }

  /** Insert or replace a record by ID (used by tests for backdating). */
  set(id: string, record: ExecutionRecord): void {
    this.map.set(id, record);
    this.queuePersist();
  }

  // --- Async operations (need mutex for serialized access) ---

  /** Mark running executions not matching `keepRunning` as stale. Returns IDs of staled executions. */
  async markMissingRunningExecutionsStale(keepRunning?: (record: ExecutionRecord) => boolean): Promise<string[]> {
    await this._pendingPersist;
    const staled: string[] = [];
    await this.mutex.run(async () => {
      const timestamp = nowIso();

      for (const record of this.map.values()) {
        if (record.status !== 'running') continue;
        if (keepRunning && keepRunning(record)) continue;
        record.status = 'stale';
        record.runtime.updatedAt = timestamp;
        record.runtime.endedAt = timestamp;
        staled.push(record.id);
      }

      if (staled.length > 0) await this.persist();
    });
    return staled;
  }

  // --- Terminal-record archival ---

  /** Default archive sibling: <dir>/archive/<basename>-archive.jsonl */
  private defaultArchivePath(): string {
    const base = path.basename(this.filePath).replace(/\.json$/, '');
    return path.join(path.dirname(this.filePath), 'archive', `${base}-archive.jsonl`);
  }

  private selectArchivable(cutoffIso: string): ExecutionRecord[] {
    const eligible: ExecutionRecord[] = [];
    for (const record of this.map.values()) {
      if (!TERMINAL_STATUSES.has(record.status)) continue;
      const endedAt = record.runtime?.endedAt || record.runtime?.updatedAt || record.runtime?.startedAt;
      if (endedAt && endedAt < cutoffIso) eligible.push(record);
    }
    return eligible;
  }

  /** Move terminal records older than `olderThanMs` into an append-only JSONL archive.
   *  Append-then-delete ordering: a crash between the two steps can duplicate archive lines
   *  but never loses a record. Returns the number of archived records.
   *
   *  Before the delete, each record is folded into the session-totals carry: a session's
   *  cumulative numbers are summed from the live registry, so a record leaving it would silently
   *  shrink that session's totals. Folding here — once, at the only place records are ever
   *  removed — keeps carry + live an exact partition. The fold runs before the archive append so a
   *  crash cannot double-count: the carry's watermark moves with the fold, and the totals query
   *  ignores live records older than it. */
  async archiveTerminal({ olderThanMs = 7 * 24 * 60 * 60 * 1000, archivePath }: {
    olderThanMs?: number; archivePath?: string;
  } = {}): Promise<number> {
    await this._pendingPersist;
    return this.mutex.run(async () => {
      const cutoffIso = new Date(Date.now() - olderThanMs).toISOString();
      const eligible = this.selectArchivable(cutoffIso);
      if (eligible.length === 0) return 0;
      await this.sessionTotals.fold(eligible, cutoffIso);
      const target = archivePath || this.defaultArchivePath();
      await mkdir(path.dirname(target), { recursive: true });
      await appendFile(target, eligible.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      for (const r of eligible) this.map.delete(r.id);
      await this.persist();
      log.info(`Archived ${eligible.length} terminal execution(s) to ${target}`);
      return eligible.length;
    });
  }

  // --- Flush & persist ---

  /** Await all pending fire-and-forget disk writes AND any in-flight async operations. */
  async flush(): Promise<void> {
    await this._pendingPersist;
    await this.mutex.run(async () => { /* acquire-release: waits for any in-flight mutex operation */ });
  }

  /** Return the current _pendingPersist promise (for tests that want to await a specific persist batch).
   *  Coalescing: map mutations are synchronous and persist() snapshots the whole map, so any
   *  mutation made before a queued persist STARTS is covered by it — a second queue entry would
   *  only re-write identical state. The flag resets right before the snapshot; mutations landing
   *  after that queue a fresh persist. Collapses sync bursts from N stringifies to 1. */
  queuePersist(): Promise<void> {
    if (this._persistQueued) return this._pendingPersist;
    this._persistQueued = true;
    this._pendingPersist = this._pendingPersist
      .catch(() => {})
      .then(() => this.mutex.run(() => {
        this._persistQueued = false;
        return this.persist();
      }))
      .catch((err) => { log.error('persist failed:', err); });
    return this._pendingPersist;
  }

  /** Atomically persist the entire Map to disk. */
  private async persist(): Promise<void> {
    const obj: ExecutionsData = {};
    for (const [id, record] of this.map) {
      obj[id] = record;
    }
    await this.repo.write(obj);
  }
}

// ── Singleton ──────────────────────────────────────────────────────

export const executionRepo = new ExecutionRepo();
registerFlushable(executionRepo);

export { ExecutionRepo };
