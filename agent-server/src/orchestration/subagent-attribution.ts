// input:  a delegating session's id and channel, plus its children's SubagentNotices
// output: attributed events pushed into the parent's live turn
// pos:    Parent-transcript side of the `agent` MCP tool
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createLogger } from '@core/log.js';
import { runRegistry, type RunningExecution } from '@core/run-registry.js';
import type { AgentProcess } from '../agent-adapter/types.js';
import type { SubagentNotice } from '../agent-adapter/pi/event-parser.js';
import { subagentNoticeEvents } from '@domain/agents/subagent/attribution.js';

const log = createLogger('subagent-attribution');

/**
 * The live turn a delegating session is running in, if any.
 *
 * The session id is the reliable key — it is what the MCP sidecar knows about its own parent — and
 * the channel is only a fallback for the executions registered before a track id was assigned. A
 * channel can host several sessions, so it is used only when it holds exactly one live execution;
 * guessing would attribute a child's work to a stranger's transcript.
 *
 * Only safe to ask while the parent is provably mid-turn — see `parentNoticeSink`, the one caller.
 */
function liveParent(sessionId: string | null, channel: string | undefined): RunningExecution | null {
  if (sessionId) {
    const bySession = runRegistry.getBySessionId(sessionId);
    if (bySession) return bySession;
  }
  if (!channel) return null;
  const onChannel = runRegistry.getByChannel(channel);
  return onChannel.length === 1 ? onChannel[0] : null;
}

/** The push seam of one registered execution, or null when it is gone or cannot take events. */
function pushableProcess(exec: RunningExecution | null): AgentProcess | null {
  const proc = exec?.agentProcess as AgentProcess | undefined;
  return typeof proc?.pushTurnEvent === 'function' ? proc : null;
}

/**
 * A sink that streams a delegating session's children into its own transcript, live.
 *
 * Returns undefined when nothing can receive the events — a TUI parent, a backend without the
 * seam, or a session whose turn the daemon cannot see. That is not an error: the run still
 * completes and its output still returns through the tool result, it just shows nothing until then.
 *
 * WHICH execution is the parent is decided once, here, where the child is being spawned from
 * inside the parent's own `agent` call and the parent is therefore provably mid-turn; every notice
 * then re-resolves that same execution by key, so a process swapped in by a retry still receives
 * events and a finished turn simply stops receiving them (delivery takes over from there).
 *
 * Re-running `liveParent` per notice instead — what this did before — wedges the daemon. Once the
 * parent's turn ends, the channel fallback starts matching whatever single execution is still live
 * there, which for a background child that outlived its parent is the child itself: its own events
 * get pushed back into its own stream, re-forwarded as notices by its notice observer, and pushed
 * again, forever, at 100% CPU with the event loop starved — no HTTP, no WS, no desktop. The child's
 * notice observer now drops attributed events too, so either guard alone closes the cycle.
 */
export function parentNoticeSink(
  sessionId: string | null, channel: string | undefined,
): ((notice: SubagentNotice) => void) | undefined {
  const parentKey = liveParent(sessionId, channel)?.registryKey;
  if (!parentKey || !pushableProcess(runRegistry.getById(parentKey))) return undefined;
  return (notice: SubagentNotice): void => {
    const proc = pushableProcess(runRegistry.getById(parentKey));
    if (!proc) return;
    try {
      for (const event of subagentNoticeEvents(notice)) proc.pushTurnEvent!(event);
    } catch (error) {
      // Attribution is decoration: a broken transcript must never fail the delegated work.
      log.warn(`Dropping subagent notice for ${sessionId ?? channel}: ${(error as Error).message}`);
    }
  };
}
