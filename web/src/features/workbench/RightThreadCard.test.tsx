// input:  SubtaskCard and a thread subtask fixture
// output: waiting-task click delegation regression
// pos:    Guards task modal opening from expanded thread cards
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadDetail } from '@cortex-agent/ui-contract';
import { SubtaskCard, taskProjectForDetail } from './RightThreadCard';

const task: ThreadDetail['subtasks'][number] = {
  id: 'c4f2',
  text: 'Create the settings module',
  status: 'open',
  actionable: false,
  claimedBy: 'task-dispatcher',
  blockedBy: null,
};

describe('RightThreadCard waiting tasks', () => {
  it('uses task provenance instead of the thread display project', () => {
    const detail = {
      projectId: 'atlas',
      artifacts: {
        artifactPath: null,
        workspacePath: null,
        taskId: 'c4f2',
        taskProject: 'nimbus',
      },
    };

    expect(taskProjectForDetail(detail)).toBe('nimbus');
    expect(taskProjectForDetail({
      ...detail,
      artifacts: { ...detail.artifacts, taskProject: null },
    })).toBe('atlas');
  });

  it('delegates the clicked task id to the modal opener', () => {
    const onOpen = vi.fn();
    const card = SubtaskCard({ task, onOpen }) as ReactElement<{
      onClick: () => void;
      'data-subtask-id': string;
    }>;

    card.props.onClick();

    expect(card.props['data-subtask-id']).toBe('c4f2');
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith('c4f2');
  });
});
