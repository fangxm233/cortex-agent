// input:  ProfilesPanelView, controller-derived profile facts/errors and config fixtures
// output: desktop table, editor gating and delete-guard regressions
// pos:    Verifies the independent desktop Profiles view renders its refusals
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigProfileEntry, ConfigSnapshot } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

vi.mock('@/design', async importOriginal => ({
  ...await importOriginal<typeof import('@/design')>(),
  Select: ({ options, value, ...props }: any) => (
    <div data-select-control data-select-value={String(value)} {...props}>
      {options.map((option: any) => <span key={String(option.value)}>{option.label}</span>)}
    </div>
  ),
}));

import { ProfilesPanelView, type ProfilesPanelViewProps } from './ProfilesPanel';
import { emptyProfileForm, formStateFromEntry, validateProfileForm } from './profiles-panel-vm';

function entry(over: Partial<ConfigProfileEntry> = {}): ConfigProfileEntry {
  return {
    name: 'plan',
    model: 'claude-opus-5',
    backend: 'claude',
    mode: 'plan',
    thinking: 'xhigh',
    provider: null,
    claudeBackend: null,
    extraOption: {},
    extraEnvKeys: [],
    fallbackCount: 0,
    ...over,
  };
}

const SOL = entry({ name: 'sol', model: 'gpt-5', backend: 'pi', mode: 'openai', provider: 'openai', thinking: null });

function snapshot(profiles: ConfigProfileEntry[], defaultProfile: string | null = 'plan'): ConfigSnapshot {
  return {
    budget: null,
    profiles: { defaultProfile, profiles },
    machines: [],
    mcp: null,
    threadTemplates: { agents: [], templates: [], shells: [] },
    hooks: [],
    env: [],
    settings: [],
  } as unknown as ConfigSnapshot;
}

function render(over: Partial<ProfilesPanelViewProps> = {}): string {
  const currentSnapshot = over.snapshot ?? snapshot([entry(), SOL]);
  const current = currentSnapshot.profiles?.defaultProfile ?? null;
  const props: ProfilesPanelViewProps = {
    snapshot: currentSnapshot,
    profileFacts: (currentSnapshot.profiles?.profiles ?? []).map(profile => ({
      profile, current: profile.name === current, canSetDefault: profile.name !== current,
      canEdit: true, canDelete: profile.name !== current,
    })),
    onSetDefaultProfile: () => {},
    draft: null,
    creating: false,
    editingName: null,
    armedDelete: null,
    errors: {},
    dirty: false,
    savePending: false,
    removePendingName: null,
    onStartCreate: () => {},
    onStartEdit: () => {},
    onCancelEdit: () => {},
    onDraftChange: () => {},
    onBackendChange: () => {},
    onSave: () => {},
    onRevert: () => {},
    onArmDelete: () => {},
    onCancelDelete: () => {},
    onConfirmDelete: () => {},
    ...over,
  };
  return renderToStaticMarkup(
    <LangProvider><ProfilesPanelView {...props} /></LangProvider>,
  );
}

describe('ProfilesPanelView / table', () => {
  it('blocks deleting the default profile and says why', () => {
    const html = render();
    expect(html).toContain('data-delete-blocked=""');
    expect(html).toContain('The default profile cannot be deleted');
    // exactly one row is blocked — the default
    expect(html.match(/data-delete-blocked/g)).toHaveLength(1);
  });

  it('arms delete on one row at a time', () => {
    const html = render({ armedDelete: 'sol' });
    expect(html).toContain('data-action="confirm-delete"');
    expect(html).toContain('data-action="cancel-delete"');
    expect(html.match(/data-action="confirm-delete"/g)).toHaveLength(1);
  });
});

describe('ProfilesPanelView / editor', () => {
  it('opens on edit with the stored values and a locked, explained name', () => {
    const html = render({ draft: formStateFromEntry(SOL), editingName: 'sol' });
    expect(html).toContain('data-profile-editor');
    expect(html).toContain('value="gpt-5"');
    expect(html).toContain('The name cannot be changed');
    expect(html).toContain('data-profile-field="name" disabled=""');
    expect(html).toContain('value="sol"');
  });

  it('shows the preserved extraEnv keys and fallback count, never a value', () => {
    const rich = entry({ name: 'rich', extraEnvKeys: ['PI_TOKEN'], fallbackCount: 2 });
    const html = render({
      snapshot: snapshot([rich], 'rich'),
      draft: formStateFromEntry(rich),
      editingName: 'rich',
    });
    expect(html).toContain('PI_TOKEN');
    expect(html).toContain('2 entries');
    expect(html).toContain('Values never leave the server');
  });

  it('reports a field error instead of the hint when the draft is invalid', () => {
    const draft = { ...emptyProfileForm(), name: 'new', model: 'gpt-5', backend: 'pi' as const };
    const html = render({
      draft,
      creating: true,
      errors: validateProfileForm(draft, { mode: 'create', existingNames: [] }),
    });
    expect(html).toContain('A pi profile must declare a provider');
  });
});
