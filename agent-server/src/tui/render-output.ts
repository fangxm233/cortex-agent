//
// Why this exists — flicker root cause (verified against ink@5.2.1 build/ink.js onRender):
// The TUI runs full-screen (root Box sized to the terminal), so on every paint Ink takes the
// `outputHeight >= stdout.rows` branch and writes `ansiEscapes.clearTerminal + output` — a full
// screen CLEAR followed immediately by a full REPAINT, as TWO separate stdout writes' worth of
// visible state. Without synchronized output the terminal refreshes mid-sequence, so the user sees
// blank → repaint = a flash, on every frame.
//
// Fix: DEC private mode 2026 (Synchronized Output). `\x1b[?2026h` (Begin Synchronized Update / BSU)
// tells the terminal to stop presenting until `\x1b[?2026l` (End / ESU). Wrapping each frame the
// clear+repaint becomes atomic — no intermediate blank frame is ever shown. Terminals that do not
// implement 2026 (it is a private mode) silently ignore both sequences, so this is safe to always
// emit. Windows Terminal, iTerm2, kitty, tmux ≥3.4, ghostty, etc. all support it.

/** Begin Synchronized Update (DEC private mode 2026 set). */
export const BSU = '\x1b[?2026h';
/** End Synchronized Update (DEC private mode 2026 reset). */
export const ESU = '\x1b[?2026l';

/** Full-screen clear sequence Ink emits for full-height output (ansiEscapes.clearTerminal core). */
const CLEAR_MARKER = '\x1b[2J';

/**
 * Wrap a frame string in synchronized-update markers so the terminal presents it atomically.
 * Pure + side-effect free so it is unit-testable. When `sync` is false it returns the chunk
 * unchanged (escape hatch via CORTEX_TUI_NO_SYNC).
 */
export function wrapFrame(chunk: string, sync: boolean): string {
  if (!sync) return chunk;
  return BSU + chunk + ESU;
}

export interface RenderStats {
  /** Number of write() calls intercepted. */
  writes: number;
  /** Total bytes (string length) written, excluding the BSU/ESU markers we add. */
  bytes: number;
  /** How many of those writes carried a full-screen clear (the flicker-prone path). */
  clears: number;
  /** epoch ms of the first and last intercepted write (for a writes/sec estimate). */
  firstAt: number;
  lastAt: number;
}

export function newRenderStats(): RenderStats {
  return { writes: 0, bytes: 0, clears: 0, firstAt: 0, lastAt: 0 };
}

/** Fold one write into the running stats (exported for testing). */
export function recordWrite(stats: RenderStats, chunk: string, now: number): void {
  stats.writes += 1;
  stats.bytes += chunk.length;
  if (chunk.includes(CLEAR_MARKER)) stats.clears += 1;
  if (stats.writes === 1) stats.firstAt = now; // first observed write (now may legitimately be 0)
  stats.lastAt = now;
}

/** Derived writes-per-second over the observed window (0 when fewer than 2 writes). */
export function writesPerSecond(stats: RenderStats): number {
  const span = stats.lastAt - stats.firstAt;
  if (span <= 0 || stats.writes < 2) return 0;
  return (stats.writes / span) * 1000;
}

export interface RenderStdoutOptions {
  /** Wrap frames in BSU/ESU (default true; disabled by CORTEX_TUI_NO_SYNC). */
  sync?: boolean;
  /** Collect render stats; the returned object is exposed on `__renderStats`. */
  stats?: RenderStats | null;
  /** Clock injection for tests. */
  now?: () => number;
}

/** A stdout proxy that also surfaces the stats object it accumulates into. */
export type RenderStdout = NodeJS.WriteStream & { __renderStats?: RenderStats | null };

/**
 * Build a proxy over `base` (typically process.stdout) that intercepts only `write` — wrapping
 * string frames in synchronized-update markers and folding them into `stats` — while delegating
 * every other property (columns/rows getters, on/off, isTTY, …) to the real stream, with `this`
 * bound to the real stream so the getters report the real terminal geometry. Ink, log-update, and
 * App's useStdout all share this one object, so they stay consistent.
 */
export function makeRenderStdout(base: NodeJS.WriteStream, options: RenderStdoutOptions = {}): RenderStdout {
  const sync = options.sync ?? true;
  const stats = options.stats ?? null;
  const now = options.now ?? Date.now;

  const wrappedWrite = (chunk: unknown, ...rest: unknown[]): boolean => {
    // Only string frames are wrapped/measured. Binary writes (rare/none here) pass through
    // untouched so we never corrupt a Buffer by string-concatenating around it.
    if (typeof chunk === 'string') {
      if (stats) recordWrite(stats, chunk, now());
      return (base.write as (c: string, ...a: unknown[]) => boolean)(wrapFrame(chunk, sync), ...rest);
    }
    return (base.write as (c: unknown, ...a: unknown[]) => boolean)(chunk, ...rest);
  };

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'write') return wrappedWrite;
      if (prop === '__renderStats') return stats;
      // Read the property off the REAL stream (so getters like `columns`/`rows` run with the
      // correct `this`), then bind methods to the real stream so calls like `.on(...)` work.
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as RenderStdout;
}
