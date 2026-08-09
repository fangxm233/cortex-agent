// input:  mounted plugin view and design mocks
// output: native mode-control accessibility tests
// pos:    Plugin mode control interaction regressions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { PluginAssignmentTarget, UiPluginCatalogEntry } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { PluginsPanelView, type PluginsPanelViewProps } from './PluginsPanel';
import { createPluginDraft } from './plugins-panel-vm';

vi.mock('@/design', async importOriginal => {
  const actual = await importOriginal<typeof import('@/design')>();
  return {
    ...actual,
    Select: ({ value, ...props }: any) => <div data-select-control data-select-value={String(value)} {...props} />,
    Modal: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  };
});

function plugin(): UiPluginCatalogEntry {
  return {
    id: 'alpha',
    kind: 'portable',
    rootDir: 'plugins/alpha',
    valid: true,
    assignable: true,
    manifest: { source: 'root', name: 'Alpha', version: '1.0.0' },
    skills: [],
    mcp: { status: 'missing', servers: [] },
    issues: [],
  };
}

function agent(): Extract<PluginAssignmentTarget, { kind: 'agent' }> {
  return {
    kind: 'agent',
    name: 'writer',
    editable: true,
    baseHash: 'hash-agent',
    managedPluginIds: ['alpha'],
    unmanagedPluginCount: 0,
  };
}

function slot(): Extract<PluginAssignmentTarget, { kind: 'template-slot' }> {
  return {
    kind: 'template-slot',
    templateName: 'workflow',
    index: 1,
    ref: 'writer',
    editable: true,
    baseHash: 'hash-slot',
    mode: 'custom',
    managedPluginIds: ['alpha'],
    unmanagedPluginCount: 0,
  };
}

function mount(onModeChange: (mode: 'inherit' | 'custom') => void) {
  const targets = [agent(), slot()];
  const props: PluginsPanelViewProps = {
    state: 'ready',
    errorMessage: null,
    plugins: [plugin()],
    targets,
    selectedKey: 'template-slot:workflow:1:writer',
    draft: createPluginDraft(targets[1], targets),
    pending: false,
    ackOpen: false,
    ackPlugins: [],
    onTargetChange: () => {},
    onModeChange,
    onTogglePlugin: () => {},
    onReset: () => {},
    onSave: () => {},
    onAckOpenChange: () => {},
    onAckConfirm: () => {},
  };
  return create(<LangProvider><PluginsPanelView {...props} /></LangProvider>);
}

describe('PluginsPanelView keyboard access', () => {
  it('uses a native button for each enabled mode choice', () => {
    const onModeChange = vi.fn();
    const renderer = mount(onModeChange);
    const inherit = renderer.root.findByProps({ 'data-plugin-mode': 'inherit' });

    act(() => inherit.props.onClick());

    expect(inherit.type).toBe('button');
    expect(inherit.props.type).toBe('button');
    expect(inherit.props.disabled).toBe(false);
    expect(inherit.props['aria-pressed']).toBe(false);
    expect(onModeChange).toHaveBeenCalledWith('inherit');
  });
});
