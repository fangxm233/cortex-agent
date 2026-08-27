// input:  created project id and ordered mobile routing callbacks
// output: project-scope-before-close-and-navigation regression coverage
// pos:    Mobile new-project completion flow unit specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it, vi } from 'vitest';
import { finishMobileProjectCreation } from './m-new-project-flow';

describe('finishMobileProjectCreation', () => {
  it('scopes to the mutation-returned id before closing and opening a new session', () => {
    const events: string[] = [];
    const setCurrentProject = vi.fn((id: string) => events.push(`scope:${id}`));
    const close = vi.fn(() => events.push('close'));
    const navigate = vi.fn((path: string) => events.push(`navigate:${path}`));

    finishMobileProjectCreation('server-project-id', { setCurrentProject, close, navigate });

    expect(events).toEqual([
      'scope:server-project-id',
      'close',
      'navigate:/m/session/new',
    ]);
  });
});
