// input:  task modal controller state transitions
// output: open, switch, and close state regressions
// pos:    Guards project-scoped global task modal selection
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { nextTaskModalRef } from './TaskModalProvider';

describe('task modal provider state', () => {
  it('opens and switches project-scoped tasks, then closes', () => {
    expect(nextTaskModalRef(null, { type: 'open', projectId: 'atlas', taskId: 'c4f2' })).toEqual({
      projectId: 'atlas',
      taskId: 'c4f2',
    });
    expect(nextTaskModalRef(
      { projectId: 'atlas', taskId: 'c4f2' },
      { type: 'open', projectId: 'nimbus', taskId: 'd404' },
    )).toEqual({ projectId: 'nimbus', taskId: 'd404' });
    expect(nextTaskModalRef(
      { projectId: 'nimbus', taskId: 'd404' },
      { type: 'close' },
    )).toBeNull();
  });
});
