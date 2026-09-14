// input:  a run's engine-start announcement plus the session name the turn runs under
// output: the backend resume target on the session record, written the moment the backend reveals it
// pos:    orchestration — resume-target persistence for a conversation turn (transcript-sink's
//         sibling: that one records what was said, this one records where to say it next)
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// Why this exists: the resume target used to reach disk only when the turn SETTLED
// (`runConversation`'s finally, fix 9809d9a3). That covers an error or a Stop, because both settle
// the run — but not the process dying mid-turn (crash, OOM, `daemon restart --hard`: the SIGTERM
// handler closes the engines and exits without letting a run settle). A session killed that way in
// its FIRST turn kept `backendSessionId: null`, so the next message opened a brand-new backend
// conversation and the transcript already on disk was orphaned — Claude's id is a fresh UUID minted
// at spawn, derivable from nothing. Turn 2+ was never exposed: turn 1 had written the pointer.
//
// So the pointer is written as early as each backend can name it:
//   - Claude mints `--session-id` at spawn, so the id exists before the first token
//     (`AgentRun.backendSessionId` is seeded when the attempt registers).
//   - PI announces its id (`engine_started`) once its runtime handle is up, before the model call.
// Writes are deduplicated against what is already on disk, so a resumed turn writes nothing unless
// the backend came back on a DIFFERENT session than the one it was asked to resume — in which case
// that new id is the resume target from now on, exactly as the success path already records it.

import { createLogger } from '@core/log.js';
import { sessionStore } from '@store/session-registry-repo.js';
import type { RunEvent } from '../domain/runs/events.js';
import type { RunObserver } from '../domain/runs/request.js';

const log = createLogger('resume-target');

/** Side-effect seams. Production callers omit these; the defaults bind the real store. */
export interface ResumeTargetSinkDeps {
  update: (
    sessionName: string,
    updates: { backendSessionId: string; lastUsedAt: string },
  ) => Promise<void>;
  now: () => string;
}

const DEFAULT_DEPS: ResumeTargetSinkDeps = {
  update: (sessionName, updates) => sessionStore.updateSession(sessionName, updates),
  now: () => new Date().toISOString(),
};

export interface ResumeTargetSinkOptions {
  /** Session record the resume target belongs to (updates are keyed by name, not by id). */
  sessionName: string;
  /** The id this turn asked the backend to resume — already on disk, so never re-written. Null on
   *  a session's first turn, where the backend names itself. */
  resumedFrom: string | null;
  /** The run's own view of the backend id, read when an event proves the engine is up but no
   *  announcement reached the stream. Optional: without it the sink relies on `engine_started`
   *  and the caller's explicit `persist` calls. */
  liveBackendSessionId?: () => string | null;
  deps?: Partial<ResumeTargetSinkDeps>;
}

export interface ResumeTargetSink extends RunObserver {
  /** Write `backendSessionId` unless it is absent or already on disk. Never throws, never blocks. */
  persist(backendSessionId: string | null): void;
  /** The id this sink has written, or was given as already-persisted. */
  readonly written: string | null;
  /** Resolves once every write this sink started has settled. Never rejects. */
  drain(): Promise<void>;
}

/**
 * Build the resume-target observer for one run.
 *
 * Writes are serialized on a promise chain so two announcements in the same turn cannot land out of
 * order, and a failure is logged rather than thrown: a registry write must never be the thing that
 * breaks a turn — the settle-time backstop in `runConversation` gets another chance.
 */
export function createResumeTargetSink(opts: ResumeTargetSinkOptions): ResumeTargetSink {
  const deps: ResumeTargetSinkDeps = { ...DEFAULT_DEPS, ...opts.deps };
  let written: string | null = opts.resumedFrom;
  let queue: Promise<void> = Promise.resolve();

  function persist(backendSessionId: string | null): void {
    if (!backendSessionId || backendSessionId === written) return;
    // Optimistic: the next caller must not queue the same write while this one is in flight.
    written = backendSessionId;
    queue = queue
      .then(() => deps.update(opts.sessionName, {
        backendSessionId,
        lastUsedAt: deps.now(),
      }))
      .catch((error: unknown) => {
        log.warn(`resume target write failed for ${opts.sessionName}: ${(error as Error).message}`);
      });
  }

  return {
    get written(): string | null { return written; },
    persist,
    drain: () => queue,
    onEvent(event: RunEvent): void {
      if (event.type === 'engine_started') {
        persist(event.backendSessionId);
        return;
      }
      // Nothing to learn once an id is on disk; while there is none, any event proves the engine
      // is running and its id may have arrived without an announcement of its own.
      if (written !== null) return;
      persist(opts.liveBackendSessionId?.() ?? null);
    },
  };
}
