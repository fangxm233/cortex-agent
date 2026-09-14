import { createLogger } from '@core/log.js';
import { isDebugMode } from '@core/debug-mode.js';
import { runRegistry, type RunningExecution } from '@core/run-registry.js';
import { createTranscriptSink } from './transcript-sink.js';
import { toRunEvent, type RunEvent, type RunPhase } from '../agent-adapter/run-events.js';
import type { RunObserver } from '../domain/runs/request.js';
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
 * events. Once that turn is over the rows do not stop — they go straight to the transcript through
 * `detachedTranscriptWriter`, which writes the same shape the run's own sink would have.
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
  const writeDetached = detachedTranscriptWriter(sessionId, channel);
  return (notice: SubagentNotice): void => {
    const run = ingestTarget(runRegistry.getById(parentKey));
    if (!run) return writeDetached(notice);
    try {
      for (const event of subagentNoticeEvents(notice)) {
        if (!run.ingestExternal(toRunEvent(event, run.phase))) return writeDetached(notice);
      }
    } catch (error) {
      // Attribution is decoration: a broken transcript must never fail the delegated work.
      log.warn(`Dropping subagent notice for ${sessionId ?? channel}: ${(error as Error).message}`);
    }
  };
}

/** The detached sink's options, kept beside the reasons each value is what it is. */
function detachedSinkFor(sessionId: string, channel: string | undefined): RunObserver {
  return createTranscriptSink({
    sessionId,
    // A parent with no channel is one no surface is routing for. `session.message` subscriptions
    // are scoped by sessionId, so an empty conduit still reaches that session's own watchers, and
    // the history row — the durable record either way — is written regardless.
    channel: channel ?? '',
    // Read only for the `context_usage` store update, and a child's notices never produce one.
    sessionName: '',
    // The same source the live turn's sink reads (`turn/turn.ts`). It is process env, so it cannot
    // have changed since the spawn; being wrong here would only drop the DEBUG-only
    // `toolUseId` / `fullInput` fields and the tool-result body.
    debug: isDebugMode(),
  });
}

/**
 * Write a child's rows straight to the transcript, for the state where the live stream cannot
 * carry them: a backgrounded child outlives the turn that spawned it, so there is no run left to
 * push into — and the delivery turn, which would close its block at a user-turn boundary, does not
 * come until the child (or its slowest sibling) is done.
 *
 * It drives the SAME `createTranscriptSink` the live turn drives, fed by the same
 * `subagentNoticeEvents` → `toRunEvent` pair, so a row that lands after the turn closed is shaped
 * exactly like one that landed while it was open — no second implementation to drift. The phase is
 * `background` because that is the truth about when these ran; it changes nothing that is
 * persisted (`transcript-sink.ts` states that phases do not change the persisted shape), it only
 * keeps the child's prose out of the platform callback, which a detached sink does not have anyway.
 *
 * Built lazily and at most once per sink: while the parent's run is alive its observers are doing
 * the writing, so a sink standing by would be a second writer for every row.
 *
 * ONLY the spawn-time `sessionId` / `channel` are used. Re-resolving the parent here would be the
 * 100% CPU accident described above: after the turn ends the one live execution left on the
 * channel is the background child itself, which would be handed its own events back forever.
 */
function detachedTranscriptWriter(
  sessionId: string | null, channel: string | undefined,
): (notice: SubagentNotice) => void {
  /** undefined = not built yet; null = nothing to write against (no session id). */
  let sink: RunObserver | null | undefined;
  return (notice: SubagentNotice): void => {
    try {
      if (sink === undefined) sink = sessionId ? detachedSinkFor(sessionId, channel) : null;
      if (!sink) return;
      for (const event of subagentNoticeEvents(notice)) {
        // `onEvent` is synchronous for every event a notice can become; guard the union anyway so
        // a future async branch cannot surface as an unhandled rejection.
        const settled = sink.onEvent(toRunEvent(event, 'background'));
        if (settled) settled.catch((e) => log.warn(`detached subagent row failed: ${(e as Error).message}`));
      }
    } catch (error) {
      // Same rule as the live path: decoration must never fail the delegated work.
      log.warn(`Dropping detached subagent notice for ${sessionId ?? channel}: ${(error as Error).message}`);
    }
  };
}
