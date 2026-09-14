// input:  a live PI AgentSession and the configured mid-turn trigger percent
// output: compaction performed INSIDE a running turn, at a tool-batch boundary
// pos:    PI's missing mid-turn context check, installed on the session's next-turn hook
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// PI checks its compaction threshold only outside the agent loop: after `agent_end`, before a new
// prompt, and on a context-overflow error (`_checkCompaction`, "Called after agent_end and before
// prompt submission"). A single Cortex turn is one whole PI agent loop, so a long tool-driven turn
// can grow past the window with no check at all and is only rescued by the overflow path.
//
// This guard adds the missing check at the one point inside the loop where it is safe: PI's own
// `prepareNextTurnWithContext`, which the loop awaits after `turn_end` (assistant message and every
// tool result are complete and persisted) and before the next provider request, and which may
// return a replacement context. Over the threshold, the guard runs PI's OWN compaction
// (`_runAutoCompaction`) — summary call, extension hooks, CompactionEntry, state rebuild, events —
// and hands the loop the rebuilt messages. Nothing is aborted, so the turn simply continues with a
// compacted context and stays one Cortex turn.

import { createLogger } from '@core/log.js';

const log = createLogger('pi-context-guard');

/** PI's per-turn hook context; only the fields the guard reads are named. */
export interface GuardTurnContext {
  message?: { content?: unknown } | null;
  context?: Record<string, unknown>;
}

export interface GuardTurnUpdate {
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

export type GuardPrepareNextTurn = (
  turn: GuardTurnContext,
  signal?: AbortSignal,
) => Promise<GuardTurnUpdate | undefined> | GuardTurnUpdate | undefined;

/** The slice of PI's AgentSession the guard drives. Structural so tests can pass a stub. */
export interface GuardSessionLike {
  agent: {
    prepareNextTurnWithContext?: GuardPrepareNextTurn;
    state: { messages: unknown[] };
  };
  settingsManager?: { getCompactionSettings?(): { enabled?: boolean } };
  getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  isCompacting?: boolean;
  /** PI-internal: the same auto-compaction it runs itself after `agent_end`. */
  _runAutoCompaction?(reason: 'threshold' | 'overflow' | 'manual', willRetry: boolean): Promise<boolean>;
}

export interface ContextGuardDeps {
  /** Trigger percent (0-100) read fresh on every check, so the setting hot-reloads. 0 disables. */
  percent: () => number;
  /** Called after an attempt, with the reading that triggered it. */
  onCompacted?: (info: { percentBefore: number; ok: boolean }) => void;
  /** Label for logs (the Cortex session key). */
  label?: string;
}

export interface PiContextGuard {
  /** Clears the per-turn "already failed" latch; called when a new Cortex turn begins. */
  resetTurn(): void;
  /** Restores the hook PI installed. */
  dispose(): void;
}

function hasToolCall(message: GuardTurnContext['message']): boolean {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => (block as { type?: unknown })?.type === 'toolCall');
}

function compactionEnabled(session: GuardSessionLike): boolean {
  const settings = session.settingsManager?.getCompactionSettings?.();
  // A session that cannot answer is assumed to compact: PI's own default is enabled.
  return settings?.enabled !== false;
}

/** The guard can only work against a session exposing all four pieces it drives. */
function supported(session: GuardSessionLike): boolean {
  return typeof session?._runAutoCompaction === 'function'
    && typeof session.getContextUsage === 'function'
    && typeof session.agent?.state?.messages?.slice === 'function';
}

/**
 * Install the mid-turn check on `session`. Returns null — and changes nothing — when the PI build
 * does not expose the pieces it needs, so an SDK upgrade degrades to today's behaviour instead of
 * breaking turns.
 */
export function installPiContextGuard(
  session: GuardSessionLike,
  deps: ContextGuardDeps,
): PiContextGuard | null {
  const label = deps.label ?? 'pi';
  if (!supported(session)) {
    log.warn(`${label}: PI session does not expose mid-turn compaction hooks; guard not installed`);
    return null;
  }
  const previous = session.agent.prepareNextTurnWithContext;
  let disposed = false;
  let running = false;
  /** One failed compaction is enough: do not pay for a summary call at every boundary after it. */
  let failedThisTurn = false;

  const shouldCheck = (turn: GuardTurnContext, signal: AbortSignal | undefined): boolean => {
    if (disposed || running || failedThisTurn) return false;
    if (signal?.aborted) return false;
    if (session.isCompacting === true) return false;
    // No tool call means the loop is about to exit anyway; PI's own post-run check owns that case.
    if (!hasToolCall(turn.message)) return false;
    return compactionEnabled(session);
  };

  const hook: GuardPrepareNextTurn = async (turn, signal) => {
    const prev = await previous?.(turn, signal);
    const percent = deps.percent();
    if (!Number.isFinite(percent) || percent <= 0) return prev;
    if (!shouldCheck(turn, signal)) return prev;
    const usage = session.getContextUsage?.();
    // `percent` is null right after a compaction, until an assistant answers on the new context.
    if (!usage || usage.percent === null || usage.percent < percent) return prev;

    running = true;
    let ok = false;
    try {
      log.info(
        `${label}: context at ${usage.percent.toFixed(1)}% of ${usage.contextWindow} — compacting mid-turn`,
      );
      ok = await session._runAutoCompaction!('threshold', false) === true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`${label}: mid-turn compaction failed: ${message}`);
    } finally {
      running = false;
    }
    deps.onCompacted?.({ percentBefore: usage.percent, ok });
    if (!ok) {
      failedThisTurn = true;
      return prev;
    }
    const base = prev?.context ?? turn.context ?? {};
    // A copy, never the live state array: the loop pushes into the context it is handed while
    // Agent.processEvents pushes into state.messages. Sharing one array duplicates every message.
    return { ...prev, context: { ...base, messages: session.agent.state.messages.slice() } };
  };

  session.agent.prepareNextTurnWithContext = hook;
  return {
    resetTurn(): void {
      failedThisTurn = false;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (session.agent.prepareNextTurnWithContext === hook) {
        session.agent.prepareNextTurnWithContext = previous;
      }
    },
  };
}
