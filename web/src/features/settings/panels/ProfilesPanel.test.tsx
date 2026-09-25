// input: profile panel view, React renderer, synthetic profile
// output: responsive profile content and action regressions
// pos: desktop profile layout contract tests
// >>> Once updated, update this header and parent AGENTS.md <<<

import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { ProfilesPanelView, type ProfilesPanelViewProps } from './ProfilesPanel';

const name = `profile-${'long-identifier-'.repeat(8)}`;
const profile = {
  name, model: `provider/${'long-model-'.repeat(12)}`, backend: 'pi' as const,
  mode: 'chat', thinking: 'high', provider: 'provider', claudeBackend: null,
  extraOption: {}, extraEnvKeys: [], fallbackCount: 0,
};

function viewProps(current = false): ProfilesPanelViewProps {
  return {
    snapshot: {
      budget: null, profiles: { defaultProfile: current ? name : null, profiles: [profile] },
      machines: [], mcp: null, threadTemplates: { agents: [], templates: [], shells: [] },
      hooks: [], env: [], settings: [],
    },
    profileFacts: [{ profile, current, canEdit: true, canDelete: !current, canSetDefault: !current }],
    draft: null, duplicateSource: null, catalog: null, catalogPending: false, creating: false,
    armedDelete: null, editingName: null, errors: {}, dirty: false,
    savePending: false, removePendingName: null,
    onStartCreate: vi.fn(), onStartDuplicate: vi.fn(), onStartEdit: vi.fn(), onCancelEdit: vi.fn(),
    onDraftChange: vi.fn(), onBackendChange: vi.fn(), onProviderChange: vi.fn(), onSave: vi.fn(),
    onRevert: vi.fn(), onArmDelete: vi.fn(), onCancelDelete: vi.fn(), onConfirmDelete: vi.fn(),
  };
}

function render(props: ProfilesPanelViewProps) {
  return create(<LangProvider><div className="settings-surface"><ProfilesPanelView {...props} /></div></LangProvider>);
}

describe('responsive desktop profiles', () => {
  it('keeps complete identifiers and localized labels for narrow cards', () => {
    const renderer = render(viewProps());
    const cells = renderer.root.findAllByProps({ className: 'settings-profile-cell' });
    expect(cells).toHaveLength(4);
    expect(cells.every(cell => typeof cell.props['data-label'] === 'string' && cell.props['data-label'])).toBe(true);
    expect(cells[0].children).toEqual([profile.model]);
    expect(renderer.root.findByProps({ 'data-profile-row': name }).props.className).toBe('settings-profile-row');
    expect(renderer.root.findByProps({ className: 'settings-profile-row settings-profile-head' })).toBeDefined();
    renderer.unmount();
  });

  it('keeps create/edit/duplicate actions and default-profile delete protection', () => {
    const props = viewProps(true);
    const renderer = render(props);
    const button = (action: string) => renderer.root.findAll(node => node.type === 'button' && node.props['data-action'] === action)[0];
    act(() => { button('new-profile').props.onClick(); button('edit').props.onClick(); button('duplicate').props.onClick(); });
    expect(props.onStartCreate).toHaveBeenCalledOnce();
    expect(props.onStartEdit).toHaveBeenCalledWith(name);
    expect(props.onStartDuplicate).toHaveBeenCalledWith(name);
    expect(button('delete').props.disabled).toBe(true);
    expect(props.onArmDelete).not.toHaveBeenCalled();
    renderer.unmount();
  });
});
