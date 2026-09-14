import { createLogger } from '@core/log.js';

const log = createLogger('rate-limiter');

/**
 * Token-bucket rate limiter with hierarchical key support.
 *
 * Keys are structured as `method` (global) or `method:channel` (per-channel).
 * Each bucket tracks tokens, last refill timestamp, and optional backoff window
 * set after a 429 response.
 *
 * The limiter is single-threaded (JS event loop), no locks needed.
 *
 * Usage:
 * ```
 * const rl = new TokenBucketRateLimiter({ globalCapacity: 20, globalRefillPerSec: 20/60 });
 * await rl.acquire('chat.postMessage', 'C123');
 * ```
 *
 * Default config values are conservative (40-60% of Slack Tier 3 limits).
 * Override via constructor options or CORTEX_SLACK_RL_* env vars.
 */
export class TokenBucketRateLimiter {
  private readonly globalCapacity: number;
  private readonly globalRefillPerSec: number;
  private readonly perChannelCapacity: number;
  private readonly perChannelRefillPerSec: number;
  private readonly cleanupIntervalMs: number;

  /** Per-key bucket state */
  private buckets = new Map<string, BucketState>();

  /** Timer handle for periodic cleanup */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    globalCapacity?: number;
    globalRefillPerSec?: number;
    perChannelCapacity?: number;
    perChannelRefillPerSec?: number;
    cleanupIntervalMs?: number;
  } = {}) {
    this.globalCapacity = opts.globalCapacity ?? 20;
    this.globalRefillPerSec = opts.globalRefillPerSec ?? 1;
    this.perChannelCapacity = opts.perChannelCapacity ?? 1;
    this.perChannelRefillPerSec = opts.perChannelRefillPerSec ?? 1;
    this.cleanupIntervalMs = opts.cleanupIntervalMs ?? 60_000;

    // Start background cleanup (does not block process exit via .unref)
    this.cleanupTimer = setInterval(() => this._cleanup(), this.cleanupIntervalMs);
    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Non-blocking token acquisition.
   * Returns `{ ok: true }` on success, or `{ ok: false, retryAfterMs }` if no
   * token is available (caller should wait `retryAfterMs` before retrying).
   */
  tryAcquire(method: string, channel?: string): { ok: boolean; retryAfterMs?: number } {
    const { globalKey, channelKey } = this._keys(method, channel);

    // Try global bucket first (always required)
    const gResult = this._tryConsume(globalKey);
    if (!gResult.ok) return gResult;

    // If channel key differs, try channel bucket
    if (channelKey !== globalKey) {
      const cResult = this._tryConsume(channelKey);
      if (!cResult.ok) {
        // Refund the global token
        this._refund(globalKey);
        return cResult;
      }
    }

    return { ok: true };
  }

  /**
   * Blocking token acquisition. Resolves when a token is available.
   * Uses polling with short intervals so it plays well with the event loop.
   */
  async acquire(method: string, channel?: string): Promise<void> {
    for (;;) {
      const result = this.tryAcquire(method, channel);
      if (result.ok) return;
      await this._sleep(Math.min(result.retryAfterMs ?? 200, 200));
    }
  }

  /**
   * Report that a 429 was received from the API.
   * Sets a backoff window for the given method (and optionally channel),
   * during which no tokens will be granted.
   */
  reportThrottled(method: string, channel?: string, retryAfterSec?: number): void {
    const durationMs = retryAfterSec && retryAfterSec > 0
      ? retryAfterSec * 1000 + 1000  // add 1s buffer
      : 10_000;                      // default 10s backoff

    const backoffUntil = Date.now() + durationMs;

    // Set backoff on both global and channel keys
    const { globalKey, channelKey } = this._keys(method, channel);
    this._getOrCreate(globalKey).backoffUntil = backoffUntil;
    if (channelKey !== globalKey) {
      this._getOrCreate(channelKey).backoffUntil = backoffUntil;
    }

    log.warn(
      `${method}${channel ? `:${channel}` : ''} received 429, backing off ${durationMs}ms`
    );
  }

  /**
   * Dispose the rate limiter: clear all state and stop the cleanup timer.
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.buckets.clear();
  }

  // --- Test support ---

  /** Exposed for testing: get internal bucket count */
  _bucketCount(): number {
    return this.buckets.size;
  }

  /** Exposed for testing: return true if backoff is active for a key */
  _isBackedOff(key: string): boolean {
    const b = this.buckets.get(key);
    return b ? b.backoffUntil > Date.now() : false;
  }

  /** Exposed for testing: simulate time passing by running cleanup + advancing state */
  _advanceTime(ms: number): void {
    const now = Date.now();
    for (const state of this.buckets.values()) {
      state.lastRefill = now - ms;
    }
  }

  // --- Private ---

  private _keys(method: string, channel?: string): { globalKey: string; channelKey: string } {
    const globalKey = `__global__:${method}`;
    const channelKey = channel ? `${method}:${channel}` : globalKey;
    return { globalKey, channelKey };
  }

  /**
   * Try to consume one token from the bucket identified by `key`.
   * Performs refill before checking.
   */
  private _tryConsume(key: string): { ok: boolean; retryAfterMs?: number } {
    const state = this._getOrCreate(key);
    const now = Date.now();

    // Check backoff
    if (state.backoffUntil > now) {
      return { ok: false, retryAfterMs: state.backoffUntil - now };
    }

    // Refill
    this._refill(state, now, key);

    // Try consume
    if (state.tokens >= 1) {
      state.tokens -= 1;
      return { ok: true };
    }

    // No tokens — estimate wait time
    const capacity = this._capacityForKey(key);
    const refillPerSec = this._refillPerSecForKey(key);
    const waitMs = refillPerSec > 0
      ? Math.ceil((1 - state.tokens) / refillPerSec * 1000)
      : 1000;
    return { ok: false, retryAfterMs: Math.min(waitMs, 5000) };
  }

  /** Refund one token (used when channel bucket rejects but global was consumed). */
  private _refund(key: string): void {
    const state = this.buckets.get(key);
    if (!state) return;
    const capacity = this._capacityForKey(key);
    state.tokens = Math.min(state.tokens + 1, capacity);
  }

  private _getOrCreate(key: string): BucketState {
    let state = this.buckets.get(key);
    if (!state) {
      const capacity = this._capacityForKey(key);
      state = { tokens: capacity, lastRefill: Date.now(), backoffUntil: 0 };
      this.buckets.set(key, state);
    }
    return state;
  }

  private _refill(state: BucketState, now: number, key: string): void {
    const elapsed = (now - state.lastRefill) / 1000;
    if (elapsed <= 0) return;
    const refillPerSec = this._refillPerSecForKey(key);
    const capacity = this._capacityForKey(key);
    state.tokens = Math.min(state.tokens + elapsed * refillPerSec, capacity);
    state.lastRefill = now;
  }

  /**
   * Determine capacity for a key.
   * Keys starting with `__global__` use global capacity; others use per-channel.
   */
  private _capacityForKey(key: string): number {
    return key.startsWith('__global__') ? this.globalCapacity : this.perChannelCapacity;
  }

  /**
   * Determine refill rate for a key.
   * Keys starting with `__global__` use global refill rate; others use per-channel.
   */
  private _refillPerSecForKey(key: string): number {
    return key.startsWith('__global__') ? this.globalRefillPerSec : this.perChannelRefillPerSec;
  }

  /**
   * Remove buckets that haven't been touched in >5 minutes.
   * Called periodically by the cleanup timer.
   */
  private _cleanup(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [key, state] of this.buckets) {
      if (state.lastRefill < cutoff && state.backoffUntil < cutoff) {
        this.buckets.delete(key);
      }
    }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

interface BucketState {
  tokens: number;
  lastRefill: number;
  backoffUntil: number;
}
