// input:  ThreadActivityRows, run/task DTO fixtures
// output: flat activity-row render regression tests
// pos:    Verifies right-thread child activity presentation
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskInfo, ThreadDispatchInfo } from '@cortex-agent/ui-contract';
import { ThreadActivityRows } from './RightThreadCard';

const run: ThreadDispatchInfo = {
  executionId: 'exec_dispatch_hidden',
  status: 'running',
  machine: 'lab2',
  type: 'dispatch',
  agentSlotId: 'coder',
  stepIndex: 0,
  taskId: 'ab12',
  runName: 'root-sweep',
  startedAt: '2026-07-06T00:00:00Z',
  finishedAt: null,
  durationMs: null,
  cost: null,
};

const task: TaskInfo = {
  id: 'cd34',
  text: 'Direct child',
  project: 'p',
  status: 'open',
  priority: 'medium',
  actionable: true,
  claimedBy: null,
  blockedBy: null,
  dependsOn: [],
  plan: null,
  template: 'coder-review',
  why: null,
  doneWhen: null,
};

describe('ThreadActivityRows', () => {
  it('renders cortex-run and direct subtask as flat sibling rows', () => {
    const html = renderToStaticMarkup(
      <ThreadActivityRows runs={[run]} subtasks={[task]} onOpenRun={() => {}} />,
    );
    expect(html).toContain('cortex-run root-sweep');
    expect(html).toContain('task cd34');
    expect(html).toContain('Direct child');
    expect(html).not.toContain('exec_dispatch_hidden');
    expect(html).not.toContain('L2');
  });
});
