// input:  profiles view, controller contract, react-test-renderer
// output: Mobile profile action layout regressions
// pos:    Verify profile actions remain reachable and wired
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigProfileEntry } from '@cortex-agent/ui-contract';
import type { ProfilesController } from '@/features/settings/controllers/useProfilesController';
import { MProfilesView } from './MProfilesScreen';
import { LangProvider } from '@/i18n';

const profile: ConfigProfileEntry = {
  name: 'research-with-a-very-long-profile-name', backend: 'pi',
  model: 'provider/long-model-name-for-small-mobile-screens', provider: 'openai',
  thinking: 'high', mode: null, claudeBackend: null,
  extraOption: {}, extraEnvKeys: [], fallbackCount: 0,
};

function controller(current = false): ProfilesController {
  return {
    snapshot: undefined, catalog: null, catalogPending: false, loading: false, error: null,
    profiles: [profile], profileFacts: [{ profile, current, canEdit: true, canSetDefault: !current, canDelete: !current }],
    defaultProfile: current ? profile.name : null, draft: null, creating: false,
    editingName: null, duplicateSource: null, errors: {}, dirty: false, confirmingDelete: null,
    createPending: false, updatePending: false, savePending: false,
    removePendingName: null, defaultPendingName: null,
    openCreate: vi.fn(), openDuplicate: vi.fn(), openEdit: vi.fn(), changeDraft: vi.fn(),
    changeBackend: vi.fn(), changeProvider: vi.fn(), closeDraft: vi.fn(), revertDraft: vi.fn(),
    save: vi.fn(), setDefault: vi.fn(), requestDelete: vi.fn(), cancelDelete: vi.fn(), confirmDelete: vi.fn(),
  };
}

describe('mobile Profiles actions', () => {
  it('places every action below long profile text and keeps action targets', () => {
    const controls = controller();
    const view = create(<LangProvider><MProfilesView controller={controls} onBack={vi.fn()} /></LangProvider>);
    const row = view.root.findByProps({ className: 'mobile-settings-row mobile-settings-row-stacked' });
    const actions = row.findByProps({ 'data-profile-actions': profile.name });
    expect(actions.props.className).toBe('mobile-settings-actions');
    const buttons = actions.findAllByType('button');
    expect(buttons).toHaveLength(4);
    act(() => buttons[0].props.onClick());
    act(() => buttons[1].props.onClick());
    act(() => buttons[2].props.onClick());
    expect(controls.setDefault).toHaveBeenCalledWith(profile.name);
    expect(controls.openEdit).toHaveBeenCalledWith(profile.name);
    expect(controls.openDuplicate).toHaveBeenCalledWith(profile.name);
  });

  it('does not offer default switching or enable deleting the current profile', () => {
    const view = create(<LangProvider><MProfilesView controller={controller(true)} onBack={vi.fn()} /></LangProvider>);
    const buttons = view.root.findByProps({ 'data-profile-actions': profile.name }).findAllByType('button');
    expect(buttons).toHaveLength(3);
    expect(buttons[2].props.disabled).toBe(true);
  });
});
