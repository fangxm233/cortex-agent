// input:  AgentRun + legacy ContinuationSink (agent-adapter)
// output: runToContinuationSink(run, sink) — a background-phase RunObserver mapped to the sink
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
export function runToContinuationSink(run: AgentRun, sink: ContinuationSink): () => void {
  // `AgentRun` emits its own `phase: background` marker the moment the foreground result leaves
  // background work behind — that is *not* the adapter's `onTurnOpen` (which fires when the
  // spontaneous continuation turn actually opens). A caller that subscribes before the foreground
  // result therefore has one marker to skip; a caller that subscribes after (the P1.5 holds, which
  // register once `runConversation` returns) never sees it and this flag stays false.
  let enteringBackground = false;

  const observer: RunObserver = {
    onEvent(event: RunEvent): void {
      switch (event.type) {
        case 'foreground_result':
          enteringBackground = true;
          return;
        case 'phase':
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
