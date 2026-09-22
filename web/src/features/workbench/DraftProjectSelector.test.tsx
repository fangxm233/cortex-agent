// input:  DraftProjectSelector, mocked project provider
// output: Project picker regression tests
// pos:    Verify project order and accessible picker controls
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
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

    expect(chip.type).toBe('button');
    expect(chip.props.className).toContain('focus-visible:outline');
    act(() => chip.props.onClick({ stopPropagation: vi.fn() }));
    expect(chip.props['aria-expanded']).toBe(true);
    expect(chip.findAllByProps({ 'data-menu': 'project' })).toHaveLength(0);

    const rows = renderer.root.findAll((node) => typeof node.props['data-project'] === 'string');
    expect(rows.map((row) => row.props['data-project'])).toEqual(['beta', 'alpha', 'gamma']);
    expect(rows.every((row) => row.type === 'button')).toBe(true);
    expect(rows[1].props['aria-pressed']).toBe(true);
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
