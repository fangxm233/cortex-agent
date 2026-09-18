import { describe, expect, it } from 'vitest';
import { taskProjectForDetail } from './RightThreadCard';

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
});
