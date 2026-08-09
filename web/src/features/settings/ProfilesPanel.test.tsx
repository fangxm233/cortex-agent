// input:  ProfilesPanelView, language provider, config snapshot fixtures
// output: table, editor gating and delete-guard regressions
// pos:    Verifies the profile CRUD surface renders its refusals
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
import { emptyProfileForm, formStateFromEntry } from './profiles-panel-vm';

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
  const props: ProfilesPanelViewProps = {
    snapshot: snapshot([entry(), SOL]),
    onSetDefaultProfile: () => {},
    draft: null,
    creating: false,
    editingName: null,
    armedDelete: null,
    saving: false,
    onStartCreate: () => {},
    onStartEdit: () => {},
    onCancelEdit: () => {},
    onDraftChange: () => {},
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
  it('renders one row per profile with the fields the DTO carries', () => {
    const html = render();
    expect(html).toContain('data-settings-panel="profiles"');
    expect(html).toContain('data-profile-row="plan"');
    expect(html).toContain('data-profile-row="sol"');
    expect(html).toContain('claude-opus-5');
    expect(html).toContain('gpt-5');
    // the undeclared thinking of the pi row reads as an em dash, never as a guess
    expect(html).toContain('—');
  });

  it('keeps the default-profile picker and its read note', () => {
    const html = render();
    expect(html).toContain('data-default-profile-select');
    expect(html).toContain('data-select-control');
    expect(html).toContain('New profile');
  });

  it('offers edit and delete per row', () => {
    const html = render();
    expect(html).toContain('data-action="edit"');
    expect(html).toContain('data-action="delete"');
  });

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

  it('says so honestly when profiles.json holds nothing', () => {
    const html = render({ snapshot: snapshot([], null) });
    expect(html).toContain('No profiles in profiles.json');
    expect(html).not.toContain('data-profile-row');
  });
});

describe('ProfilesPanelView / editor', () => {
  it('stays closed until a draft exists', () => {
    expect(render()).not.toContain('data-profile-editor');
  });

  it('opens on edit with the stored values and a locked, explained name', () => {
    const html = render({ draft: formStateFromEntry(SOL), editingName: 'sol' });
    expect(html).toContain('data-profile-editor');
    expect(html).toContain('value="gpt-5"');
    expect(html).toContain('The name cannot be changed');
    expect(html).toContain('data-profile-field="name" disabled=""');
    expect(html).toContain('value="sol"');
  });

  it('lets a create name its profile', () => {
    const html = render({ draft: emptyProfileForm(), creating: true });
    expect(html).toContain('data-profile-field="name"');
    expect(html).not.toContain('data-profile-field="name" disabled=""');
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
    const html = render({
      draft: { ...emptyProfileForm(), name: 'new', model: 'gpt-5', backend: 'pi' },
      creating: true,
    });
    expect(html).toContain('A pi profile must declare a provider');
  });

  it('offers custom selectors for backend, thinking and Claude output mode', () => {
    const claude = render({ draft: formStateFromEntry(entry()), editingName: 'plan' });
    expect(claude).toContain('data-profile-field="backend"');
    expect(claude).toContain('data-profile-field="thinking"');
    expect(claude).toContain('data-profile-field="claudeBackend"');
    expect(claude.match(/data-select-control/g)).toHaveLength(4);

    expect(render({ draft: formStateFromEntry(SOL), editingName: 'sol' }))
      .not.toContain('data-profile-field="claudeBackend"');
  });
});
