// input:  waitpoints.json
// output: WaitpointRepo (get / list / listArmed / insert / update / remove / mutate / flush) + the Waitpoint shape
// pos:    Persistence for waitpoints — durable, externally addressable "wake me when X finishes" objects.
//         A waitpoint is created by an agent, carries its own capability secret, and is resolved by a
//         signal arriving from outside the process (HTTP route, local spool file, or a device spool drain).
//         The shape lives here rather than in domain/ because store/ must not import from domain/ (D10).

import * as path from 'path';
import { JsonRepository } from '@core/json-repository.js';
import { STORE_DIR } from '@core/paths.js';

export const WAITPOINTS_FILE = path.join(STORE_DIR, 'waitpoints.json');

/** Terminal signals resolve a waitpoint; `progress` is recorded but never resolves one. */
export type SignalStatus = 'ok' | 'fail' | 'progress';

export type WaitpointState = 'armed' | 'fired' | 'expired' | 'cancelled';

/** Where the signal is expected to come from. Drives whether the sweep drains a device's spool dir. */
export type WaitpointEmitFrom = { kind: 'local' } | { kind: 'device'; device: string };

export interface WaitpointOwner {
  /** Cortex session that created it. Diagnostic — delivery is addressed by `channel`. */
  sessionId: string;
  /** The conduit the wake turn is delivered to. Find-or-creates a session if it is gone. */
  channel: string;
  /** Recorded only; v1 never wakes a thread directly. */
  threadId?: string | null;
  project?: string | null;
}

export interface WaitpointSignal {
  at: number;
  status: SignalStatus;
  /** Quorum member key this signal counts for. Absent ⇒ an anonymous slot is allocated. */
  member?: string | null;
  message?: string | null;
  data?: unknown;
  /** Free-form provenance for the notice, e.g. `http`, `spool`, `device:lab-ksu`. */
  source: string;
  /** Idempotency key. A second signal carrying a key already present is dropped as a duplicate. */
  dedupeKey?: string | null;
  /** Set once this signal has been folded into a delivered wake notice, so a later wake on the
   *  same (mailbox) waitpoint reports only what is new. */
  deliveredAt?: number | null;
}

export interface Waitpoint {
  /** `wp_<12 hex>`. Public — appears in notices and logs. */
  id: string;
  /** sha256 of the capability secret. The plaintext is returned once, at creation, and never stored. */
  secretHash: string;
  label: string;
  /** What the agent said it was waiting for. Echoed into the wake notice so a cold turn is self-contained. */
  intent: string;
  owner: WaitpointOwner;
  emitFrom: WaitpointEmitFrom;
  /** `need` terminal signals resolve it. `'all'` means "one per declared member". */
  quorum: { need: number | 'all'; members: string[]; got: string[] };
  /** A `fail` resolves immediately even when the quorum is unmet — "tell me when the first one breaks". */
  failFast: boolean;
  /** How many times it may fire before closing. 1 = one-shot (default); >1 = a mailbox. */
  maxSignals: number;
  fires: number;
  /** Signals landing within this window after the first are folded into one wake notice. */
  coalesceMs: number;
  createdAt: number;
  expiresAt: number;
  /** Set when the waitpoint left `armed`. Echoed on a late signal so the caller can log it. */
  resolvedAt?: number | null;
  state: WaitpointState;
  signals: WaitpointSignal[];
  /** WAL bit: a fire that has not been delivered yet. Replayed at boot and by the sweep. */
  delivery: { pending: boolean; attempts: number; lastError?: string | null; lastAt?: number | null };
  /** Wake timestamps, newest last. Sliding-window rate limit input. */
  wakes: number[];
  /** Set once when the rate limit first bites, so the warning notice is emitted exactly once. */
  rateLimitNotified?: boolean;
}

/** Shape of waitpoints.json: `{ "wp_…": Waitpoint, … }` */
export type WaitpointsData = Record<string, Waitpoint>;

function defaultData(): WaitpointsData {
  return {};
}

/**
 * Shape guard. Must be idempotent: JsonRepository runs migrate on every cold read and writes the
 * result straight back when it differs, so a non-idempotent migrate rewrites the file on every boot.
 */
function migrate(raw: unknown): WaitpointsData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return defaultData();
  const out: WaitpointsData = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const wp = value as Waitpoint;
    if (typeof wp.id !== 'string' || typeof wp.secretHash !== 'string') continue;
    out[id] = wp;
  }
  return out;
}

export class WaitpointRepo {
  private readonly _repo: JsonRepository<WaitpointsData>;

  constructor(opts: { filePath?: string } = {}) {
    this._repo = new JsonRepository<WaitpointsData>({
      filePath: opts.filePath ?? WAITPOINTS_FILE,
      defaultValue: defaultData,
      migrate,
    });
  }

  async get(id: string): Promise<Waitpoint | null> {
    const data = await this._repo.read();
    return data[id] ?? null;
  }

  async list(): Promise<Waitpoint[]> {
    return Object.values(await this._repo.read());
  }

  async listArmed(): Promise<Waitpoint[]> {
    return (await this.list()).filter((wp) => wp.state === 'armed');
  }

  async insert(wp: Waitpoint): Promise<void> {
    await this._repo.mutate((data) => {
      data[wp.id] = wp;
      return { next: data, result: undefined };
    });
  }

  /**
   * Read-modify-write one waitpoint under the repo mutex. The callback receives the live record and
   * returns `{ next, result }`; returning `next: null` deletes it. Resolves to `null` when the id is
   * unknown, so callers can distinguish "gone" from "handled".
   */
  async update<R>(
    id: string,
    fn: (wp: Waitpoint) => { next: Waitpoint | null; result: R },
  ): Promise<R | null> {
    return this._repo.mutate((data) => {
      const current = data[id];
      if (!current) return { next: data, result: null as R | null };
      const { next, result } = fn(current);
      if (next === null) delete data[id];
      else data[id] = next;
      return { next: data, result: result as R | null };
    });
  }

  async remove(id: string): Promise<void> {
    await this._repo.mutate((data) => {
      delete data[id];
      return { next: data, result: undefined };
    });
  }

  /** Generic mutate passthrough for composite operations (sweeps touching many records at once). */
  async mutate<R>(fn: (data: WaitpointsData) => { next: WaitpointsData; result: R }): Promise<R> {
    return this._repo.mutate(fn);
  }

  /** Wait for any in-flight mutate() to complete. For graceful SIGTERM drain. */
  flush(): Promise<void> {
    return this._repo.flush();
  }

  /** Test hook. */
  invalidate(): void {
    this._repo.invalidate();
  }
}

export const waitpointRepo = new WaitpointRepo();
