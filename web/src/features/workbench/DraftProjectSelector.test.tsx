// input:  Mocked project context, draft selector, and bilingual vocabulary
// output: Current-project visibility, switching, and pending-state regressions
// pos:    Desktop draft project selector behavior specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';

const harness = vi.hoisted(() => ({
  setCurrentProject: vi.fn(),
}));

vi.mock('@/features/projects/CurrentProjectProvider', () => ({
  useCurrentProject: () => ({
    currentProjectId: 'alpha',
    projects: [{ id: 'alpha' }, { id: 'beta' }],
    setCurrentProject: harness.setCurrentProject,
  }),
}));

vi.mock('@/design', async () => {
  const React = await import('react');
  return {
    Select: (props: { value: string; disabled?: boolean; onValueChange: (value: string) => void }) =>
      React.createElement('project-select', {
        value: props.value,
        disabled: props.disabled,
        onChange: () => props.onValueChange('beta'),
      }),
  };
});

import { DraftProjectSelector } from './DraftProjectSelector';

describe('DraftProjectSelector', () => {
  it('shows the current project and writes a new shared selection', () => {
    const renderer = create(<LangProvider><DraftProjectSelector /></LangProvider>);
    const select = renderer.root.findByType('project-select' as never);

    expect(select.props.value).toBe('alpha');
    expect(JSON.stringify(renderer.toJSON())).toContain('Project');
    act(() => select.props.onChange());
    expect(harness.setCurrentProject).toHaveBeenCalledWith('beta');
  });

  it('passes the create-and-send pending gate to the select', () => {
    const renderer = create(<LangProvider><DraftProjectSelector disabled /></LangProvider>);
    expect(renderer.root.findByType('project-select' as never).props.disabled).toBe(true);
  });
});
