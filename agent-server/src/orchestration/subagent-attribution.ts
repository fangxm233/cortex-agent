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

function parentProcess(sessionId: string | null, channel: string | undefined): AgentProcess | null {
  const proc = liveParent(sessionId, channel)?.agentProcess as AgentProcess | undefined;
  return typeof proc?.pushTurnEvent === 'function' ? proc : null;
}

/**
 * A sink that streams a delegating session's children into its own transcript, live.
 *
 * Returns undefined when nothing can receive the events — a TUI parent, a backend without the
 * seam, or a session whose turn the daemon cannot see. That is not an error: the run still
 * completes and its output still returns through the tool result, it just shows nothing until
 * then. The parent process is resolved per notice rather than captured once, because a turn can
 * end (and a background run outlive it) in the middle of a child's work.
 */
export function parentNoticeSink(
  sessionId: string | null, channel: string | undefined,
): ((notice: SubagentNotice) => void) | undefined {
  if (!parentProcess(sessionId, channel)) return undefined;
  return (notice: SubagentNotice): void => {
    const proc = parentProcess(sessionId, channel);
    if (!proc) return;
    try {
      for (const event of subagentNoticeEvents(notice)) proc.pushTurnEvent!(event);
    } catch (error) {
      // Attribution is decoration: a broken transcript must never fail the delegated work.
      log.warn(`Dropping subagent notice for ${sessionId ?? channel}: ${(error as Error).message}`);
    }
  };
}
