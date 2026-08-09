// input:  plugin view props, design mocks, language copy
// output: plugin metadata and read-only view tests
// pos:    Static desktop plugin panel regressions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PluginAssignmentTarget, UiPluginCatalogEntry } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { en } from '@/i18n/vocab';
import { getSettingsNav } from './settings-nav';
import { PluginsPanelView, type PluginsPanelViewProps } from './PluginsPanel';
import { createPluginDraft, setPluginDraftMode, type PluginsPanelDraft } from './plugins-panel-vm';

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
    templateName: 'bound',
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

function baseTargets(): PluginAssignmentTarget[] {
  return [agent(), slot(), shell(), ACTIVE_SLOT];
}

function render(over: Partial<PluginsPanelViewProps> = {}): string {
  const targets = over.targets ?? baseTargets();
  const selectedKey = over.selectedKey ?? 'agent:writer';
  const selected = targets.find((item) => item.kind === 'agent' && item.name === 'writer') ?? targets[0] ?? null;
  const draft = over.draft !== undefined ? over.draft : (selected ? createPluginDraft(selected, targets) : null);
  const props: PluginsPanelViewProps = {
    state: 'ready',
    errorMessage: null,
    plugins: PLUGINS,
    targets,
    selectedKey,
    draft,
    pending: false,
    ackOpen: false,
    ackPlugins: [],
    onTargetChange: () => {},
    onModeChange: () => {},
    onTogglePlugin: () => {},
    onReset: () => {},
    onSave: () => {},
    onAckOpenChange: () => {},
    onAckConfirm: () => {},
    ...over,
  };
  return renderToStaticMarkup(<LangProvider><PluginsPanelView {...props} /></LangProvider>);
}

function inheritDraft(): PluginsPanelDraft {
  const targets = [agent({ managedPluginIds: ['gamma', 'alpha'] }), slot()];
  return setPluginDraftMode(createPluginDraft(targets[1], targets), targets[1], targets, 'inherit');
}

describe('plugins settings navigation', () => {
  it('places plugins after thread templates', () => {
    const keys = getSettingsNav(en).map(entry => entry.key);
    expect(keys.indexOf('plugins')).toBe(keys.indexOf('templates') + 1);
  });
});

describe('PluginsPanelView catalog metadata', () => {
  it('shows metadata, localized kind/transport labels, and sanitized MCP summaries', () => {
    const html = render();

    expect(html).toContain('Alpha manifest');
    expect(html).toContain('Manifest source');
    expect(html).toContain('Portable');
    expect(html).toContain('Legacy');
    expect(html).toContain('Unknown');
    expect(html).toContain('stdio');
    expect(html).toContain('HTTP stream');
    expect(html).toContain('scope plugin');
    expect(html).toContain('code warn');
    expect(html).toContain('path plugin.json');
    expect(html).toContain('./bin/private-server');
    expect(html).toContain('SECRET_TOKEN');
    expect(html).toContain('https://api.example.com/mcp');
    expect(html).not.toContain('Bearer secret');
    expect(html).not.toContain('token=super-secret');
  });

});

describe('PluginsPanelView catalog gating', () => {
  it('shows invalid selected plugins as removable while unselected ones stay disabled', () => {
    const reviewer = agent({ name: 'reviewer', managedPluginIds: [] });
    const selectedHtml = render({ targets: [agent()] });
    const disabledHtml = render({ targets: [reviewer], selectedKey: 'agent:reviewer', draft: createPluginDraft(reviewer, [reviewer]) });

    expect(selectedHtml).toContain('data-plugin-row="broken"');
    expect(selectedHtml).toContain('data-plugin-disabled="false"');
    expect(disabledHtml).toContain('data-plugin-disabled="true"');
    expect(disabledHtml).toContain('data-plugin-disabled-reason="invalid"');
  });

  it('disables every plugin toggle while a slot draft inherits', () => {
    const html = render({ selectedKey: 'template-slot:workflow:1:writer', draft: inheritDraft() });

    expect(html).toContain('data-plugin-row="alpha"');
    expect(html).toContain('data-plugin-disabled-reason="readonly"');
  });
});

describe('PluginsPanelView toggle semantics', () => {
  it('names plugin switches and exposes their assignment state', () => {
    const html = render({ targets: [agent()] });

    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="Assign Alpha"');
    expect(html).toContain('aria-checked="true"');
  });
});

describe('PluginsPanelView target mode state', () => {
  it('shows unmanaged notice, exact modes, and dirty target gating', () => {
    const dirtyDraft = { ...createPluginDraft(agent(), [agent()]), pluginIds: ['alpha'] };
    const html = render({ selectedKey: 'template-slot:workflow:1:writer', draft: inheritDraft() });
    const dirty = render({ draft: dirtyDraft });
    const pending = render({ pending: true, draft: dirtyDraft });

    expect(html).toContain('Preserves 2 unmanaged paths');
    expect(html).toContain('data-plugin-mode="inherit" data-selected="true"');
    expect(html).toContain('data-plugin-mode="custom" data-selected="false"');
    expect(dirty).toContain('data-select-disabled="true"');
    expect(pending).toContain('data-select-disabled="true"');
  });

});

describe('PluginsPanelView target guards', () => {
  it('marks readonly targets as disabled options with reasons', () => {
    const html = render({ selectedKey: 'template-slot:workflow:2:__active__', draft: null });

    expect(html).toContain('data-select-option="template-shell:bound"');
    expect(html).toContain('data-select-option-disabled="true"');
    expect(html).toContain('data-select-option-reason="This shell binding is read-only');
    expect(html).toContain('data-select-option-reason="This target is resolved at run time');
  });

  it('gates save and reset when clean or pending', () => {
    const clean = render();
    const dirty = render({ draft: { ...createPluginDraft(agent(), [agent()]), pluginIds: ['alpha'] } });
    const pending = render({ pending: true, draft: { ...createPluginDraft(agent(), [agent()]), pluginIds: ['alpha'] } });

    expect(clean).toContain('data-action="save" data-disabled="true"');
    expect(dirty).toContain('data-action="save" data-disabled="false"');
    expect(dirty).toContain('data-action="reset" data-disabled="false"');
    expect(pending).toContain('data-action="save" data-disabled="true"');
  });
});

describe('PluginsPanelView MCP modal and empty states', () => {
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
    expect(render({ targets: [], selectedKey: null, draft: null })).toContain('No plugin targets found');
  });
});
