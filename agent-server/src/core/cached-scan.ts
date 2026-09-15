// input:  an async scan that produces a list, plus a clock, a TTL and a retry delay
// output: a cached view of that list — peek (no side effect), get (serve + refresh when stale),
//         ensure (wait out a cold scan, bounded), refresh (force)
// pos:    core — the caching half of `agent-adapter/pi/discovery`, lifted out so the Anthropic
//         model discovery does not grow a second copy of the same four methods. Holds no
//         knowledge of what is being scanned; every policy comes in through options.

export interface CachedScanOptions<T> {
  scan: () => Promise<T[]>;
  /** How long an accepted result stays fresh. */
  cacheTtlMs: number;
  /** How long a FAILED scan is not retried — the backoff that keeps a broken source cheap. */
  retryMs: number;
  now?: () => number;
  /** Stable identity of one entry; later duplicates are dropped. Omit to keep the list verbatim. */
  key?: (entry: T) => string;
  /** Defensive copy handed to callers, so a caller cannot mutate the cache through its answer. */
  clone?: (entry: T) => T;
  /** One line per failed scan. Receives the reason, never the caller's secrets. */
  logFailure?: (message: string) => void;
}

/** An unref'd timer: a pending wait must never be the reason a process stays alive. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class CachedScan<T> {
  private entries: T[] = [];
  private nextRefreshAt = 0;
  private inFlight: Promise<void> | null = null;
  private refreshQueued = false;
  private readonly now: () => number;

  constructor(private readonly options: CachedScanOptions<T>) {
    this.now = options.now ?? Date.now;
  }

  /** The snapshot alone, with no refresh kicked — for callers that merely decorate something with
   *  the list and must not provoke the cost of producing it. */
  peek(): T[] {
    const clone = this.options.clone;
    return clone ? this.entries.map(clone) : [...this.entries];
  }

  /** The snapshot, with a background refresh when it has gone stale. */
  get(): T[] {
    const snapshot = this.peek();
    if (this.now() >= this.nextRefreshAt && !this.inFlight) this.startRefresh();
    return snapshot;
  }

  /**
   * The snapshot, waiting for a scan only when there is nothing to show.
   *
   * For callers whose whole purpose IS the list (a model picker): an empty answer is useless to
   * them, so a cold cache is worth waiting on — but a warm one is returned at once. A scan that
   * just failed left a backoff, and this honours it: an empty answer now beats holding a UI
   * request open on a failure we already know about.
   */
  async ensure(timeoutMs: number): Promise<T[]> {
    if (this.entries.length > 0) return this.get();
    if (!this.inFlight && this.now() >= this.nextRefreshAt) this.startRefresh();
    const pending = this.inFlight;
    if (pending) await Promise.race([pending, delay(timeoutMs)]);
    return this.peek();
  }

  refresh(): void {
    if (!this.inFlight) {
      this.startRefresh();
      return;
    }
    this.refreshQueued = true;
  }

  private startRefresh(): void {
    const refresh = Promise.resolve()
      .then(this.options.scan)
      .then((entries) => this.accept(entries))
      .catch((error: unknown) => this.reject(error))
      .finally(() => this.finishRefresh(refresh));
    this.inFlight = refresh;
  }

  private finishRefresh(refresh: Promise<void>): void {
    if (this.inFlight !== refresh) return;
    this.inFlight = null;
    if (!this.refreshQueued) return;
    this.refreshQueued = false;
    this.startRefresh();
  }

  private accept(entries: T[]): void {
    const { key, clone } = this.options;
    const seen = new Set<string>();
    const deduped: T[] = [];
    for (const entry of entries) {
      if (key) {
        const id = key(entry);
        if (seen.has(id)) continue;
        seen.add(id);
      }
      deduped.push(clone ? clone(entry) : entry);
    }
    this.entries = deduped;
    this.nextRefreshAt = this.now() + this.options.cacheTtlMs;
  }

  private reject(error: unknown): void {
    this.nextRefreshAt = this.now() + this.options.retryMs;
    const message = error instanceof Error ? error.message : 'unknown';
    this.options.logFailure?.(message);
  }
}
