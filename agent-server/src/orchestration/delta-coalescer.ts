// input:  incremental assistant text chunks (blockId + text) from the agent adapters
// output: createDeltaCoalescer (batched {blockId, text, seq} flushes) + createSessionDeltaStream
//         (the per-turn sink, and the single gate deciding which sessions stream at all)
// pos:    orch/ — sits between the adapter's per-token deltas and the EventBus publish, so the bus,
//         the SSE subscription queues and the browser see a bounded event rate no matter how chatty
//         a backend is.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { isWebChannel } from './bg-continuation.js';
import { isStreamDeltasEnabled } from '../agent-adapter/claude/spawn-args.js';
import { publishSessionMessageDelta } from './session-events.js';

/** Publish at most one event per block per window, so a chatty backend cannot outrun consumers. */
export const DEFAULT_FLUSH_MS = 120;

/** …but never sit on more than this much text: a fast burst should reach the reader promptly. */
export const MAX_PENDING_CHARS = 400;

export interface DeltaFlush {
  blockId: string;
  /** The chunks accumulated since the previous flush of this block — an increment, not a total. */
  text: string;
  /** 0 for a block's first published event, +1 per event after that. Lets a consumer detect gaps. */
  seq: number;
}

export interface DeltaCoalescerOptions {
  onFlush: (flush: DeltaFlush) => void;
  /** Window length; defaults to resolveFlushMs(process.env). */
  flushMs?: number;
  /** Character cap that short-circuits the window; defaults to MAX_PENDING_CHARS. */
  maxChars?: number;
}

export interface DeltaCoalescer {
  /** Accumulate one incremental chunk. Empty chunks are ignored. */
  push(blockId: string, text: string): void;
  /** Publish what is pending for `blockId` (or for every block when omitted) right now. Callers
   *  MUST do this before the block's complete message goes out, so the preview never trails the
   *  authoritative text. */
  flush(blockId?: string): void;
  /** Drop everything pending and cancel every timer — the coalescer stays inert afterwards. */
  dispose(): void;
}

/**
 * Window length from the environment. Anything that is not a non-negative integer falls back to the
 * default rather than silently disabling batching. `0` is meaningful: publish on the next tick.
 */
export function resolveFlushMs(env: Record<string, string | undefined>): number {
  const raw = env.CORTEX_STREAM_DELTA_MS;
  if (raw === undefined || raw === '') return DEFAULT_FLUSH_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_FLUSH_MS;
  return Math.floor(n);
}

interface BlockState {
  pending: string;
  seq: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createDeltaCoalescer(opts: DeltaCoalescerOptions): DeltaCoalescer {
  const flushMs = opts.flushMs ?? resolveFlushMs(process.env);
  const maxChars = opts.maxChars ?? MAX_PENDING_CHARS;
  const blocks = new Map<string, BlockState>();
  let disposed = false;

  function emit(blockId: string, state: BlockState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.pending.length === 0) return;
    const flush: DeltaFlush = { blockId, text: state.pending, seq: state.seq };
    state.pending = '';
    state.seq += 1;
    // A failing sink is not the streaming path's problem: the block keeps accumulating and the
    // authoritative complete message is unaffected either way.
    try { opts.onFlush(flush); } catch { /* contained on purpose */ }
  }

  return {
    push(blockId: string, text: string): void {
      if (disposed || !text) return;
      let state = blocks.get(blockId);
      if (!state) {
        state = { pending: '', seq: 0, timer: null };
        blocks.set(blockId, state);
      }
      state.pending += text;
      if (state.pending.length >= maxChars) {
        emit(blockId, state);
        return;
      }
      if (state.timer === null) {
        state.timer = setTimeout(() => {
          const s = blocks.get(blockId);
          if (s) {
            s.timer = null;
            emit(blockId, s);
          }
        }, flushMs);
      }
    },

    flush(blockId?: string): void {
      if (disposed) return;
      if (blockId === undefined) {
        for (const [id, state] of blocks) emit(id, state);
        return;
      }
      const state = blocks.get(blockId);
      if (state) emit(blockId, state);
    },

    dispose(): void {
      disposed = true;
      for (const state of blocks.values()) {
        if (state.timer !== null) clearTimeout(state.timer);
      }
      blocks.clear();
    },
  };
}

export interface SessionDeltaStream {
  /** Feed one incremental chunk from the adapter. */
  onDelta(text: string, blockId: string): void;
  /** Publish what is pending — call this immediately before the block's complete message. */
  flush(blockId?: string): void;
  /** End of turn: cancel timers, drop anything unpublished. */
  dispose(): void;
}

/**
 * Bind the coalescer to one session's event stream — and decide whether that session may stream
 * at all. Returns null when it may not, which is the single place the "Web UI only" product rule
 * is enforced:
 *
 *  - Slack, Feishu and the Ink TUI render complete messages through OutputStream; a partial block
 *    there would mean edit-storms or duplicated text, so they get no stream and their code path is
 *    byte-for-byte what it was.
 *  - A session with no id has nothing to key events by.
 *  - `CORTEX_STREAM_DELTAS=0` turns the whole feature off (the same switch that stops the CLI from
 *    producing deltas in the first place).
 *
 * Callers therefore need no gate of their own: a null return means "no streaming callback".
 */
export function createSessionDeltaStream(args: {
  sessionId: string | null;
  channel: string;
  /** Injected for tests; defaults to the real EventBus publish. */
  publish?: (p: { sessionId: string; channel: string; blockId: string; text: string; seq: number }) => void;
  flushMs?: number;
}): SessionDeltaStream | null {
  const { sessionId, channel } = args;
  if (!sessionId) return null;
  if (!isWebChannel(channel)) return null;
  if (!isStreamDeltasEnabled()) return null;

  const publish = args.publish ?? publishSessionMessageDelta;
  const coalescer = createDeltaCoalescer({
    flushMs: args.flushMs,
    onFlush: ({ blockId, text, seq }) => publish({ sessionId, channel, blockId, text, seq }),
  });

  return {
    onDelta: (text: string, blockId: string) => coalescer.push(blockId, text),
    flush: (blockId?: string) => coalescer.flush(blockId),
    dispose: () => coalescer.dispose(),
  };
}
