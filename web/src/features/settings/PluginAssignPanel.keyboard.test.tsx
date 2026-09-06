// input:  mounted assignment view and design mocks
// output: native mode-control accessibility tests
// pos:    Plugin assignment mode control interaction regressions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { PluginAssignmentTarget, UiPluginCatalogEntry } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { PluginAssignView, type PluginAssignViewProps } from './PluginAssignPanel';
import { createPluginDraft } from './plugin-assign-vm';

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
    scope: 'always',
    origin: 'local',
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
  const props: PluginAssignViewProps = {
    state: 'ready',
    errorMessage: null,
    locked: false,
    plugins: [plugin()],
    scopedTargets: [targets[1]],
    selectedKey: 'template-slot:workflow:1:writer',
    target: targets[1],
    draft: createPluginDraft(targets[1], targets),
    unmanagedCount: 0,
    pending: false,
    busy: false,
    ackOpen: false,
    ackPlugins: [],
    onSelectTarget: () => {},
    onModeChange,
    onTogglePlugin: () => {},
    onReset: () => {},
    onSave: () => {},
    onAckOpenChange: () => {},
    onAckConfirm: () => {},
  };
  return create(<LangProvider><PluginAssignView {...props} /></LangProvider>);
}

describe('PluginAssignView keyboard access', () => {
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
