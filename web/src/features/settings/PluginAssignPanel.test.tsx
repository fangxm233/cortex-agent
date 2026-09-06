// input:  assignment view props, design mocks, language copy
// output: plugin assignment gating, mode, and acknowledgement regressions
// pos:    Static plugin assignment control regressions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PluginAssignmentTarget, UiPluginCatalogEntry } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { PluginAssignView, type PluginAssignViewProps } from './PluginAssignPanel';
import { createPluginDraft, pluginTargetKey, setPluginDraftMode, type PluginsPanelDraft } from './plugin-assign-vm';

const modalProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

function MockSelect({ options, value, disabled, ...props }: any) {
  return (
    <div data-select-control data-select-value={String(value)}
      data-select-disabled={String(Boolean(disabled))} {...props}>
      {options.map((option: any) => (
        <div key={String(option.value)} data-select-option={String(option.value)}
          data-select-option-disabled={String(Boolean(option.disabled))}
          data-select-option-reason={option.disabledReason ?? ''}>
          <span>{option.label}</span>
          {option.description ? <span>{option.description}</span> : null}
        </div>
      ))}
    </div>
  );
}

function MockModal(props: Record<string, unknown> & {
  children?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  modalProps.push(props);
  if (!props.open) return null;
  return (
    <div data-modal-layer={String(props.layer)}>
      <div>{props.title as React.ReactNode}</div>
      <div>{props.description as React.ReactNode}</div>
      <div>{props.children}</div><div>{props.footer}</div>
    </div>
  );
}

vi.mock('@/design', async importOriginal => ({
  ...await importOriginal<typeof import('@/design')>(),
  Select: MockSelect,
  Modal: MockModal,
}));

function plugin(over: Partial<UiPluginCatalogEntry> = {}): UiPluginCatalogEntry {
  return {
    id: 'alpha',
    kind: 'portable',
    scope: 'always',
    rootDir: 'plugins/alpha',
    valid: true,
    assignable: true,
    manifest: { source: 'root', name: 'Alpha', version: '1.0.0', description: 'Alpha manifest' },
    skills: [{ name: 'review' }],
    mcp: { status: 'missing', servers: [] },
    issues: [],
    ...over,
  };
}

function agent(
  over: Partial<Extract<PluginAssignmentTarget, { kind: 'agent' }>> = {},
): Extract<PluginAssignmentTarget, { kind: 'agent' }> {
  return {
    kind: 'agent' as const,
    name: 'writer',
    editable: true,
    baseHash: 'hash-agent',
    managedPluginIds: ['broken', 'alpha'],
    unmanagedPluginCount: 2,
    ...over,
  };
}

function slot(
  over: Partial<Extract<PluginAssignmentTarget, { kind: 'template-slot' }>> = {},
): Extract<PluginAssignmentTarget, { kind: 'template-slot' }> {
  return {
    kind: 'template-slot' as const,
    templateName: 'workflow',
    index: 1,
    ref: 'writer',
    editable: true,
    baseHash: 'hash-slot',
    mode: 'custom' as const,
    managedPluginIds: ['alpha'],
    unmanagedPluginCount: 1,
    ...over,
  };
}

function shell(
  over: Partial<Extract<PluginAssignmentTarget, { kind: 'template-shell' }>> = {},
): Extract<PluginAssignmentTarget, { kind: 'template-shell' }> {
  return {
    kind: 'template-shell' as const,
    templateName: 'workflow',
    editable: false,
    baseHash: 'hash-shell',
    readOnlyReason: 'shell-binding' as const,
    ...over,
  };
}

const ACTIVE_SLOT = slot({
  index: 2,
  ref: '__active__',
  editable: false,
  mode: 'inherit',
  managedPluginIds: [],
  readOnlyReason: 'active-agent',
});

const PLUGINS: UiPluginCatalogEntry[] = [
  plugin({
    issues: [{ code: 'warn', scope: 'plugin', path: 'plugin.json', message: 'Manifest warning' }],
    mcp: {
      status: 'valid',
      servers: [
        { name: 'local', type: 'stdio', summary: { command: './bin/private-server', argsCount: 2, envKeys: ['SECRET_TOKEN'] } },
        { name: 'remote', type: 'streamable-http', summary: { origin: 'https://api.example.com/mcp', headerKeys: ['Authorization', 'X-Team'] } },
      ],
    },
  }),
  plugin({
    id: 'broken',
    kind: 'legacy',
    valid: false,
    assignable: false,
    manifest: { source: 'legacy', name: 'Broken', version: '0.1.0' },
    skills: [],
    issues: [{ code: 'invalid', scope: 'manifest', path: 'plugin.json', message: 'Broken manifest' }],
  }),
  plugin({ id: 'gamma', kind: 'unknown', manifest: { source: 'none', name: 'Gamma', version: '3.0.0' }, skills: [] }),
];

function render(over: Partial<PluginAssignViewProps> = {}): string {
  const scopedTargets = over.scopedTargets ?? [agent()];
  const target = over.target !== undefined ? over.target : (scopedTargets[0] ?? null);
  const draft = over.draft !== undefined
    ? over.draft
    : (target ? createPluginDraft(target, scopedTargets) : null);
  const props: PluginAssignViewProps = {
    state: 'ready',
    errorMessage: null,
    locked: false,
    plugins: PLUGINS,
    scopedTargets,
    selectedKey: target ? pluginTargetKey(target) : null,
    target,
    draft,
    unmanagedCount: 0,
    pending: false,
    busy: false,
    ackOpen: false,
    ackPlugins: [],
    onSelectTarget: () => {},
    onModeChange: () => {},
    onTogglePlugin: () => {},
    onReset: () => {},
    onSave: () => {},
    onAckOpenChange: () => {},
    onAckConfirm: () => {},
    ...over,
  };
  return renderToStaticMarkup(<LangProvider><PluginAssignView {...props} /></LangProvider>);
}

function inheritDraft(): PluginsPanelDraft {
  const targets = [agent({ managedPluginIds: ['gamma', 'alpha'] }), slot()];
  return setPluginDraftMode(createPluginDraft(targets[1], targets), targets[1], targets, 'inherit');
}

describe('PluginAssignView catalog rows', () => {
  it('lists each plugin compactly and never leaks MCP values into the row', () => {
    const html = render();

    expect(html).toContain('Alpha manifest');
    expect(html).toContain('1 skills');
    expect(html).toContain('2 MCP');
    expect(html).not.toContain('./bin/private-server');
    expect(html).not.toContain('SECRET_TOKEN');
    expect(html).not.toContain('Bearer secret');
  });

  it('warns that a scoped plugin still will not load everywhere it is assigned', () => {
    const scoped = plugin({ id: 'delta', scope: 'channel', scopePrefix: 'feishu:' });
    const html = render({ plugins: [scoped] });

    expect(html).toContain('data-plugin-scope="channel"');
    expect(html).toContain('only on channels starting with &quot;feishu:&quot;');
  });
});

describe('PluginAssignView catalog gating', () => {
  it('shows invalid selected plugins as removable while unselected ones stay disabled', () => {
    const reviewer = agent({ name: 'reviewer', managedPluginIds: [] });
    const selectedHtml = render({ scopedTargets: [agent()] });
    const disabledHtml = render({ scopedTargets: [reviewer] });

    expect(selectedHtml).toContain('data-plugin-row="broken"');
    expect(selectedHtml).toContain('data-plugin-disabled="false"');
    expect(disabledHtml).toContain('data-plugin-disabled="true"');
    expect(disabledHtml).toContain('data-plugin-disabled-reason="invalid"');
  });

  it('disables every plugin toggle while a slot draft inherits', () => {
    const html = render({ scopedTargets: [slot()], draft: inheritDraft() });

    expect(html).toContain('data-plugin-row="alpha"');
    expect(html).toContain('data-plugin-disabled-reason="readonly"');
  });

  it('freezes the form while the JSON body holds unsaved edits', () => {
    const html = render({ locked: true, pending: true });

    expect(html).toContain('data-plugin-locked');
    expect(html).toContain('Save or revert the JSON body first');
    expect(html).toContain('data-plugin-disabled-reason="readonly"');
  });

  it('still offers Reset while locked, so a draft made earlier is not stranded', () => {
    const draft = { ...createPluginDraft(agent(), [agent()]), pluginIds: ['alpha'] };
    const html = render({ locked: true, pending: true, busy: false, draft });

    expect(html).toContain('data-action="save" data-disabled="true"');
    expect(html).toContain('data-action="reset" data-disabled="false"');
  });
});

describe('PluginAssignView toggle semantics', () => {
  it('names plugin switches and exposes their assignment state', () => {
    const html = render({ scopedTargets: [agent()] });

    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="Assign Alpha"');
    expect(html).toContain('aria-checked="true"');
  });
});

describe('PluginAssignView slot mode state', () => {
  it('shows unmanaged notice, exact modes, and dirty slot gating', () => {
    const slots = [slot(), slot({ index: 3, ref: 'reviewer' })];
    const html = render({ scopedTargets: [slot()], draft: inheritDraft(), unmanagedCount: 2 });
    const dirtyDraft = { ...createPluginDraft(agent(), [agent()]), pluginIds: ['alpha'] };
    const dirty = render({ scopedTargets: slots, target: slots[0], draft: dirtyDraft });
    const pending = render({ scopedTargets: slots, target: slots[0], pending: true, draft: dirtyDraft });

    expect(html).toContain('Preserves 2 unmanaged paths');
    expect(html).toContain('data-plugin-mode="inherit" data-selected="true"');
    expect(html).toContain('data-plugin-mode="custom" data-selected="false"');
    expect(dirty).toContain('data-select-disabled="true"');
    expect(pending).toContain('data-select-disabled="true"');
  });

  it('hides the slot picker when the entity owns a single target', () => {
    expect(render({ scopedTargets: [agent()] })).not.toContain('data-select-control');
  });
});

describe('PluginAssignView stale draft guard', () => {
  it('requires reset after a conflicting refetch', () => {
    const draft = { ...createPluginDraft(agent(), [agent()]), baseHash: 'stale-hash', pluginIds: ['alpha'] };
    const html = render({ draft });

    expect(html).toContain('data-plugin-conflict');
    expect(html).toContain('Reset this stale draft');
    expect(html).toContain('data-action="save" data-disabled="true"');
    expect(html).toContain('data-action="reset" data-disabled="false"');
  });
});

describe('PluginAssignView target guards', () => {
  it('marks readonly slots as disabled options with reasons', () => {
    const scopedTargets = [slot(), shell(), ACTIVE_SLOT];
    const html = render({ scopedTargets, target: ACTIVE_SLOT, draft: null });

    expect(html).toContain('data-select-option="template-shell:workflow"');
    expect(html).toContain('data-select-option-disabled="true"');
    expect(html).toContain('data-select-option-reason="This shell binding is read-only');
    expect(html).toContain('data-select-option-reason="This target is resolved at run time');
    expect(html).toContain('data-plugin-readonly="active-agent"');
  });

  it('gates save and reset when clean or pending', () => {
    const dirtyDraft = { ...createPluginDraft(agent(), [agent()]), pluginIds: ['alpha'] };
    const clean = render();
    const dirty = render({ draft: dirtyDraft });
    const pending = render({ pending: true, draft: dirtyDraft });

    expect(clean).toContain('data-action="save" data-disabled="true"');
    expect(dirty).toContain('data-action="save" data-disabled="false"');
    expect(dirty).toContain('data-action="reset" data-disabled="false"');
    expect(pending).toContain('data-action="save" data-disabled="true"');
  });
});

describe('PluginAssignView MCP modal and empty states', () => {
  it('opens a nested acknowledgement modal that lists only sanitized summaries', () => {
    modalProps.length = 0;
    const html = render({ ackOpen: true, ackPlugins: [PLUGINS[0]] });

    expect(modalProps[0]).toMatchObject({ open: true, layer: 'nested' });
    expect(html).toContain('Acknowledge MCP access');
    expect(html).toContain('run local code or send tool data over the network');
    expect(html).toContain('./bin/private-server');
    expect(html).toContain('Authorization');
    expect(html).not.toContain('Bearer secret');
  });

  it('renders loading, error, no catalog, and no targets states', () => {
    expect(render({ state: 'loading' })).toContain('Loading plugins…');
    expect(render({ state: 'error', errorMessage: 'boom' })).toContain('Failed to load plugins: boom');
    expect(render({ plugins: [] })).toContain('No plugins found');
    expect(render({ scopedTargets: [], target: null, draft: null })).toContain('No plugin targets found');
  });
});
