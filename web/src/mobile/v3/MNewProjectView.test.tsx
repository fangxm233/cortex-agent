// input:  mobile new-project view props with backend error and pending state
// output: real-error presentation and submit-gating regressions
// pos:    Mobile new-project sheet presentation specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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
  it('shows the real project-create error', () => {
    const renderer = create(
      <MNewProjectView
        name="nimbus"
        onNameChange={vi.fn()}
        onCreate={vi.fn()}
        onClose={vi.fn()}
        copy={copy}
        error="Project already exists: nimbus"
        pending={false}
      />,
    );

    expect(renderer.root.findByProps({ 'data-project-create-error': true }).children.join('')).toBe(
      'Project already exists: nimbus',
    );
  });

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
