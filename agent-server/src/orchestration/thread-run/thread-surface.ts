// input:  the status message a run draws on + the renderer that turns a step report into text
// output: the `ThreadSurface` the thread runner reports on (T1.1's domain→interface port)
// pos:    orchestration/thread-run — every progress write goes through `status-helpers.writeStatus`,
//         the same serialized chain the conversation path uses. That is the fix behind plan §3-2:
//         the runner's old bare `adapter.updateMessage` could land AFTER the terminal seal and
//         overwrite the summary, and it dropped the Cancel button because it carried no blocks.

import type { MessageRef, PlatformAdapter } from '@platform/index.js';
import type { ThreadSurface } from '@core/types/thread-types.js';
import { writeStatus } from '../status-helpers.js';

/** What `turn.buildInteractiveCallbacks` returns; null for a surface with no live user. */
export interface InteractiveCapture {
  onToolUse?: ((name: string, input: any) => void) | null;
  onPlanWritten?: ((event: { path: string; content: string; toolUseId: string }) => void) | null;
  onAskUserQuestion?: ((event: { toolUseId: string; questions: Array<{ question: string; options?: string[]; multi?: boolean }> }) => void) | null;
}

/** Renders one step report as a status line, or null to draw nothing for it. `phase` separates
 *  the two reports a renderer may treat differently: the scheduler's line is only redrawn on
 *  in-step progress (its step boundary has always drawn nothing), while the multi-agent line is
 *  redrawn on both. */
export type ProgressRenderer = (info: {
  threadId: string;
  phase: 'step-started' | 'step-progress';
  stepNumber: number;
  label: string;
  multiAgent: boolean;
  numTurns: number | null;
  durationMs: number | null;
  startTime: number;
}) => string | null;

export function createThreadSurface(opts: {
  adapter: PlatformAdapter;
  statusMsg: MessageRef | null;
  threadId: string;
  startTime: number;
  renderProgress: ProgressRenderer;
  interactive: InteractiveCapture | null;
}): ThreadSurface {
  const { adapter, statusMsg, threadId, startTime, renderProgress, interactive } = opts;
  const text = (
    phase: 'step-started' | 'step-progress', stepNumber: number, label: string,
    multiAgent: boolean, numTurns: number | null, durationMs: number | null,
  ): string | null =>
    statusMsg ? renderProgress({ threadId, phase, stepNumber, label, multiAgent, numTurns, durationMs, startTime }) : null;

  return {
    onStepStarted({ stepNumber, label, multiAgent }) {
      const line = text('step-started', stepNumber, label, multiAgent, null, null);
      if (line === null) return;
      // Returned so the runner keeps its "status line lands before the step starts" ordering.
      return writeStatus(adapter, statusMsg!, line);
    },
    onStepProgress({ stepNumber, label, multiAgent, numTurns, durationMs }) {
      const line = text('step-progress', stepNumber, label, multiAgent, numTurns, durationMs);
      if (line === null) return;
      void writeStatus(adapter, statusMsg!, line).catch(() => {});
    },
    onToolUse: interactive?.onToolUse ?? null,
    onPlanWritten: interactive?.onPlanWritten ?? null,
    onAskUserQuestion: interactive?.onAskUserQuestion ?? null,
  };
}
