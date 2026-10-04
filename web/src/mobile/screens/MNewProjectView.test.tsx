import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/mobile/ui/kit', () => ({
  MBottomSheet: ({ children }: { children: unknown }) => children,
  MC: { ink: 'ink', faint: 'faint' },
}));

import { MNewProjectView } from './MNewProjectView';

describe('MNewProjectView', () => {
  it('disables duplicate submits while creation is pending', () => {
    const renderer = create(
      <MNewProjectView
        name="nimbus"
        onNameChange={vi.fn()}
        onCreate={vi.fn()}
        onClose={vi.fn()}
        error={null}
        pending
      />,
    );

    expect(renderer.root.findByType('button').props.disabled).toBe(true);
  });
});
