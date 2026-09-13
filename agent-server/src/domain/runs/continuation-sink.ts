// input:  AgentRun + legacy ContinuationSink (agent-adapter)
// output: runToContinuationSink(run, sink, waits) — a background-phase RunObserver mapped to the sink
// pos:    domain/runs — lets legacy background holds subscribe to a run without owning
//         proc.setContinuationSink (which AgentRun already installed).
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { ContinuationSink } from '../../agent-adapter/types.js';
import type { RunEvent } from './events.js';
import type { RunObserver } from './request.js';
import type { AgentRun } from './run.js';

/**
 * Subscribe `sink` to a run's background-phase events, replayed with the exact order the legacy
 * adapter would have used. Returns the unsubscribe function.
 *
 * Why this exists (P1.5): `AgentRun` installs its own `ContinuationSink` on the process so every
 * adapter signal reaches the run's observer fan-out. `AgentProcess.setContinuationSink` is a single
 * slot, so the legacy background holds (`web-bg-hold`, `bg-continuation`) can no longer register
 * directly; they subscribe here and receive the same callbacks they always did. P4.1 folds the hold
 * logic into the run and deletes this.
 */
/** The three things a hold used to get from its own `bg-wait-guard`. The run owns the timers now
 *  (it is the only thing that knows when the background phase starts and ends); these deliver its
 *  verdict to the surface that renders it. */
export interface BackgroundWaitCallbacks {
  /** Unnotified work never reported in: the run has finalized, so seal as a normal completion. */
  onGraceTimeout?: () => void;
  /** Still-running work passed the cap: seal the status as "still running". The run stays in the
   *  background phase, so a very late continuation still streams through this same sink. */
  onMaxWait?: () => void;
  /** The wait is over, whatever ended it — a timeout, a final result, an interruption. Fires
   *  exactly once. This is the old guard's `settle()`: release the busy bracket here. */
  onWaitEnded?: () => void;
}

export function runToContinuationSink(
  run: AgentRun, sink: ContinuationSink, waits: BackgroundWaitCallbacks = {},
): () => void {
  // A hold both streams and persists the background turn, so it owns those rows; any other observer
  // watching the same run (today: the mid-turn injection ledger) must not write them a second time.
  run.claimBackgroundTranscript();
  // `AgentRun` emits its own `phase: background` marker the moment the foreground result leaves
  // background work behind — that is *not* the adapter's `onTurnOpen` (which fires when the
  // spontaneous continuation turn actually opens). A caller that subscribes before the foreground
  // result therefore has one marker to skip; a caller that subscribes after (the P1.5 holds, which
  // register once `runConversation` returns) never sees it and this flag stays false.
  let enteringBackground = false;
  let waitEnded = false;
  const endWait = (): void => {
    if (waitEnded) return;
    waitEnded = true;
    waits.onWaitEnded?.();
  };

  const observer: RunObserver = {
    onEvent(event: RunEvent): void {
      switch (event.type) {
        case 'foreground_result':
          enteringBackground = true;
          return;
        case 'background_timeout':
          // Order matches the guard this replaced: release the bracket, then report the verdict.
          endWait();
          if (event.reason === 'grace') waits.onGraceTimeout?.();
          else waits.onMaxWait?.();
          return;
        case 'phase':
          if (event.phase === 'done') { endWait(); return; }
          if (event.phase !== 'background') return;
          if (enteringBackground) {
            enteringBackground = false;
            return;
          }
          sink.onTurnOpen?.();
          return;
        case 'assistant_text':
          if (event.phase !== 'background') return;
          sink.onAssistantText(event.text, event.model, event.subagent);
          return;
        case 'tool_use':
          if (event.phase !== 'background') return;
          sink.onToolUse?.(event.name, event.input, event.toolUseId, event.subagent);
          return;
        case 'tool_result':
          if (event.phase !== 'background') return;
          sink.onToolResult?.(event.toolUseId, event.content, !event.ok, event.subagent);
          return;
        case 'context_usage':
          if (event.phase !== 'background') return;
          sink.onContextUsage?.(event);
          return;
        case 'subagent_end':
          if (event.phase !== 'background') return;
          sink.onSubagentEnd?.(event.parentToolUseId, event.status);
          return;
        case 'background_result':
          sink.onResult(event.result);
          return;
        default:
          return;
      }
    },
  };

  return run.subscribe(observer);
}
