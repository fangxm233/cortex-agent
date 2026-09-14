// input:  ProfilesPanelView, controller-derived facts/errors, catalog and config fixtures
// output: desktop table, editor gating, field-picker and delete-guard regressions
// pos:    Verifies the independent desktop Profiles view renders its refusals
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  ConfigProfileEntry, ConfigSnapshot, ModelCatalogSnapshot,
} from '@cortex-agent/ui-contract';
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

const CATALOG: ModelCatalogSnapshot = {
  routes: [
    { endpoint: 'anthropic', backend: 'claude', provider: null, modes: ['plan'],
      models: ['claude-opus-5'], source: 'builtin' },
    { endpoint: 'deepseek', backend: 'pi', provider: 'deepseek', modes: ['deepseek'],
      models: ['deepseek-v4-flash'], source: 'pi' },
  ],
  piPending: false,
};

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
    duplicateSource: null,
    catalog: null,
    catalogPending: false,
    creating: false,
    editingName: null,
    armedDelete: null,
    errors: {},
    dirty: false,
    savePending: false,
    removePendingName: null,
    onStartCreate: () => {},
    onStartDuplicate: () => {},
    onStartEdit: () => {},
    onCancelEdit: () => {},
    onDraftChange: () => {},
    onBackendChange: () => {},
    onProviderChange: () => {},
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

  it('types model / provider / mode when no catalog can offer a list', () => {
    const html = render({ draft: formStateFromEntry(SOL), editingName: 'sol' });
    // No catalog ⇒ no dropdown may appear: an endpoint the host cannot enumerate must stay writable.
    for (const field of ['model', 'provider', 'mode']) {
      expect(html).toContain(`data-profile-field="${field}" data-profile-choice="custom"`);
    }
  });

  it('picks model / provider / mode from the catalog, keeping a custom escape', () => {
    const html = render({
      draft: formStateFromEntry(entry({
        name: 'ds', model: 'deepseek-v4-flash', backend: 'pi', mode: 'deepseek', provider: 'deepseek',
      })),
      editingName: 'plan',
      catalog: CATALOG,
    });
    for (const field of ['model', 'provider', 'mode']) {
      expect(html).toContain(`data-profile-field="${field}" data-profile-choice="select"`);
    }
    expect(html).toContain('deepseek-v4-flash');
    expect(html).toContain('Custom…');
  });

  it('offers a duplicate per row and states what a copy leaves behind', () => {
    const rich = entry({ name: 'rich', extraEnvKeys: ['PI_TOKEN'], fallbackCount: 2 });
    const table = render({ snapshot: snapshot([entry(), rich]) });
    expect(table.match(/data-action="duplicate"/g)).toHaveLength(2);

    const copying = render({
      draft: { ...formStateFromEntry(rich), name: '' },
      creating: true,
      duplicateSource: 'rich',
    });
    expect(copying).toContain('Copied from rich');
    expect(copying).toContain('extraEnv and fallback are not copied');
  });

  it('says why a model list is empty instead of showing a bare picker', () => {
    const pi = render({
      draft: { ...emptyProfileForm(), name: 'new', backend: 'pi' },
      creating: true,
      catalog: CATALOG,
    });
    expect(pi).toContain('Pick a provider to list its models');
    const loading = render({
      draft: { ...emptyProfileForm(), name: 'new' }, creating: true, catalogPending: true,
    });
    expect(loading).toContain('Reading the model catalog…');
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
