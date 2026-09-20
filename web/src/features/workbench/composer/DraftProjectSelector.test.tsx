import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { LangProvider } from '@/i18n';

const harness = vi.hoisted(() => ({
  setCurrentProject: vi.fn(),
}));

vi.mock('@/features/projects/CurrentProjectProvider', () => ({
  useCurrentProject: () => ({
    currentProjectId: 'alpha',
    projects: [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }],
    projectOrder: ['beta', 'alpha'],
    setCurrentProject: harness.setCurrentProject,
  }),
}));

import { DraftProjectSelector } from './DraftProjectSelector';

beforeEach(() => {
  harness.setCurrentProject.mockReset();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});

afterEach(() => vi.unstubAllGlobals());

describe('DraftProjectSelector', () => {
  it('follows the full left-rail order and selects the picked project', () => {
    const renderer = create(<LangProvider><DraftProjectSelector /></LangProvider>);
    const chip = renderer.root.findByProps({ 'data-chip': 'project' });

    act(() => chip.props.onClick({ stopPropagation: vi.fn() }));

    const rows = renderer.root.findAll((node) => typeof node.props['data-project'] === 'string');
    expect(rows.map((row) => row.props['data-project'])).toEqual(['beta', 'alpha', 'gamma']);
    act(() => rows[0].props.onClick({ stopPropagation: vi.fn() }));
    expect(harness.setCurrentProject).toHaveBeenCalledWith('beta');
  });

  it('does not open while create-and-send is pending', () => {
    const renderer = create(<LangProvider><DraftProjectSelector disabled /></LangProvider>);
    const chip = renderer.root.findByProps({ 'data-chip': 'project' });
    act(() => chip.props.onClick({ stopPropagation: vi.fn() }));
    expect(renderer.root.findAllByProps({ 'data-menu': 'project' })).toHaveLength(0);
  });
});
