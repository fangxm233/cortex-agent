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

/** Renders one step report as a status line, or null to draw nothing for it. */
export type ProgressRenderer = (info: {
  threadId: string;
  stepNumber: number;
  label: string;
  multiAgent: boolean;
  numTurns: number | null;
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
  const text = (stepNumber: number, label: string, multiAgent: boolean, numTurns: number | null): string | null =>
    statusMsg ? renderProgress({ threadId, stepNumber, label, multiAgent, numTurns, startTime }) : null;

  return {
    onStepStarted({ stepNumber, label, multiAgent }) {
      const line = text(stepNumber, label, multiAgent, null);
      if (line === null) return;
      // Returned so the runner keeps its "status line lands before the step starts" ordering.
      return writeStatus(adapter, statusMsg!, line);
    },
    onStepProgress({ stepNumber, label, multiAgent, numTurns }) {
      const line = text(stepNumber, label, multiAgent, numTurns);
      if (line === null) return;
      void writeStatus(adapter, statusMsg!, line).catch(() => {});
    },
    onToolUse: interactive?.onToolUse ?? null,
    onPlanWritten: interactive?.onPlanWritten ?? null,
    onAskUserQuestion: interactive?.onAskUserQuestion ?? null,
  };
}
