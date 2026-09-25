import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/mobile/ui/kit', () => ({
  MBottomSheet: ({ children }: { children: unknown }) => children,
  MC: { ink: 'ink', faint: 'faint' },
  MONO: 'mono',
}));

import { MNewProjectView } from './MNewProjectView';

const copy = {
  title: 'New project',
  tag: 'projects/',
  placeholder: 'Project name',
  create: 'Create and start a chat',
};

describe('MNewProjectView', () => {
  it('disables duplicate submits while creation is pending', () => {
    const renderer = create(
      <MNewProjectView
        name="nimbus"
        onNameChange={vi.fn()}
        onCreate={vi.fn()}
        onClose={vi.fn()}
        copy={copy}
        error={null}
        pending
      />,
    );

    expect(renderer.root.findByType('button').props.disabled).toBe(true);
  });
});
