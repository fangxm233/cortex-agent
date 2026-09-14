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
