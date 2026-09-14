import { createLogger } from '@core/log.js';
import { runRegistry, type RunningExecution } from '@core/run-registry.js';
import { conversationHistory } from '@store/conversation-history-repo.js';
import { publishSessionMessage } from './session-events.js';
import { toRunEvent, type RunEvent, type RunPhase } from '../agent-adapter/run-events.js';
import type { SubagentNotice } from '../agent-adapter/pi/event-parser.js';
import { subagentNoticeEvents } from '@core/agents/subagent/attribution.js';

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

/**
 * The ingest seam of one registered execution's run, or null when it is gone or already over. The
 * seam lives on the run — the owner of the event stream — not on a process handle: a child's rows
 * are a producer into that one stream, tagged with whatever phase the parent is in when they land.
 *
 * Declared structurally because `RunningExecution.run` is a core-level port that deliberately does
 * not know the run layer's types.
 */
interface IngestRun {
  readonly phase: RunPhase;
  ingestExternal(event: RunEvent): boolean;
}

function ingestTarget(exec: RunningExecution | null): IngestRun | null {
  const run = exec?.run as unknown as IngestRun | undefined;
  return run && typeof run.ingestExternal === 'function' ? run : null;
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
  if (!parentKey || !ingestTarget(runRegistry.getById(parentKey))) return undefined;
  return (notice: SubagentNotice): void => {
    const run = ingestTarget(runRegistry.getById(parentKey));
    if (!run) return sealWithoutRun(sessionId, channel, notice);
    try {
      for (const event of subagentNoticeEvents(notice)) {
        if (!run.ingestExternal(toRunEvent(event, run.phase))) {
          return sealWithoutRun(sessionId, channel, notice);
        }
      }
    } catch (error) {
      // Attribution is decoration: a broken transcript must never fail the delegated work.
      log.warn(`Dropping subagent notice for ${sessionId ?? channel}: ${(error as Error).message}`);
    }
  };
}

/**
 * Write a settled child's end straight to the transcript, for the state where the live stream
 * cannot carry it: a backgrounded child of a parallel batch finishes after its parent's turn
 * closed, so there is no run left to push into — and the batch's delivery turn, which would close
 * the block as a user-turn boundary, does not come until its slowest sibling is done too.
 *
 * Rows are still dropped in that state; they are decoration, and a finished turn is not the place
 * for them. The end is not decoration: without it that child's block spins for as long as the rest
 * of the batch takes. Same two writes the transcript sink performs, so the row the client receives
 * and the history line a later reader parses are identical either way.
 */
function sealWithoutRun(
  sessionId: string | null, channel: string | undefined, notice: SubagentNotice,
): void {
  if (notice.kind !== 'end' || !notice.status || !sessionId) return;
  const ts = new Date().toISOString();
  conversationHistory
    .appendSubagentEnd(sessionId, { subagentId: notice.ref, status: notice.status, ts })
    .catch((error) => log.warn(`subagent-end write failed: ${(error as Error).message}`));
  if (!channel) return;
  publishSessionMessage({
    sessionId, channel, role: 'assistant', text: '', ts,
    subagentId: notice.ref, subagentEnded: notice.status,
  });
}
