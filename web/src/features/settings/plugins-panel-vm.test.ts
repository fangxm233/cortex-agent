// input:  plugin DTO fixtures and assignment helpers
// output: order, inherit, hash, and MCP payload tests
// pos:    Plugin assignment view-model regressions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { PluginAssignmentTarget, UiPluginCatalogEntry } from '@cortex-agent/ui-contract';
import {
  buildPluginsAssignArgs,
  createPluginDraft,
  draftMcpPlugins,
  pluginDraftState,
  pluginTargetKey,
  pluginToggleDisabledReason,
  resolvePluginTarget,
  resolvePluginTargetKey,
  setPluginDraftMode,
  syncPluginDraft,
  togglePluginDraftId,
} from './plugins-panel-vm';

function plugin(over: Partial<UiPluginCatalogEntry> = {}): UiPluginCatalogEntry {
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
    unmanagedPluginCount: 1,
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
    unmanagedPluginCount: 2,
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

const PLUGINS = [
  plugin(),
  plugin({ id: 'broken', valid: false, assignable: false, manifest: { source: 'root', name: 'Broken', version: '0.1.0' } }),
  plugin({
    id: 'mcp-plugin',
    manifest: { source: 'root', name: 'MCP', version: '2.0.0' },
    mcp: {
      status: 'valid',
      servers: [{
        name: 'local',
        type: 'stdio',
        summary: { command: './bin/server', argsCount: 2, envKeys: ['SECRET_TOKEN'] },
      }],
    },
  }),
];

describe('plugins panel VM target identity', () => {
  it('keys every target shape and falls back to the first live target', () => {
    const targets = [agent(), slot(), shell()];

    expect(pluginTargetKey(targets[0])).toBe('agent:writer');
    expect(pluginTargetKey(targets[1])).toBe('template-slot:workflow:1:writer');
    expect(pluginTargetKey(targets[2])).toBe('template-shell:bound');
    expect(resolvePluginTarget(targets, 'template-slot:workflow:1:writer')).toEqual(targets[1]);
    expect(resolvePluginTargetKey(targets, 'missing')).toBe('agent:writer');
  });
});

describe('plugins panel VM inherit payload', () => {
  it('switching to inherit keeps the referenced agent order and exact payload ids', () => {
    const targets = [
      agent({ managedPluginIds: ['gamma', 'alpha', 'gamma', 'beta'] }),
      slot({ mode: 'custom', managedPluginIds: ['alpha'] }),
    ];
    const draft = setPluginDraftMode(createPluginDraft(targets[1], targets), targets[1], targets, 'inherit');

    expect(draft.baseHash).toBe('hash-slot');
    expect(draft.pluginIds).toEqual(['gamma', 'alpha', 'beta']);
    expect(buildPluginsAssignArgs(targets[1], draft)).toEqual({
      target: {
        kind: 'template-slot',
        templateName: 'workflow',
        index: 1,
        ref: 'writer',
        baseHash: 'hash-slot',
        mode: 'inherit',
      },
      pluginIds: ['gamma', 'alpha', 'beta'],
    });
  });

});

describe('plugins panel VM inherited gating', () => {
  it('disables all plugin toggles while a slot draft inherits the agent set', () => {
    const targets = [agent({ managedPluginIds: ['gamma', 'alpha'] }), slot()];
    const inherited = setPluginDraftMode(createPluginDraft(targets[1], targets), targets[1], targets, 'inherit');

    expect(pluginToggleDisabledReason(targets[1], inherited, plugin({ id: 'gamma' }))).toBe('readonly');
    expect(togglePluginDraftId(inherited, targets[1], plugin({ id: 'gamma' })).pluginIds).toEqual(['gamma', 'alpha']);
    expect(pluginDraftState(targets[1], inherited, false).canSave).toBe(true);
  });
});

describe('plugins panel VM lifecycle safety', () => {
  it('preserves a dirty draft as conflicted when its target hash changes', () => {
    const initial = slot({ baseHash: 'hash-old', managedPluginIds: ['alpha'] });
    const changed = slot({ baseHash: 'hash-new', managedPluginIds: ['beta', 'alpha'] });
    const dirty = togglePluginDraftId(createPluginDraft(initial, [agent(), initial]), initial, plugin({ id: 'beta' }));

    const synced = syncPluginDraft(changed, [agent(), changed], dirty);
    const state = pluginDraftState(changed, synced, false);

    expect(synced).toBe(dirty);
    expect(state).toEqual({ dirty: true, conflicted: true, canSave: false, canReset: true });
  });

  it('refreshes a clean draft when its target hash changes', () => {
    const initial = agent({ baseHash: 'hash-old', managedPluginIds: ['alpha'] });
    const changed = agent({ baseHash: 'hash-new', managedPluginIds: ['beta'] });

    const synced = syncPluginDraft(changed, [changed], createPluginDraft(initial, [initial]));

    expect(synced.baseHash).toBe('hash-new');
    expect(synced.pluginIds).toEqual(['beta']);
  });
});

describe('plugins panel VM inherited dependency sync', () => {
  it('resets inherit draft when its agent changes without a template hash change', () => {
    const target = slot({ mode: 'inherit', managedPluginIds: ['beta', 'alpha'] });
    const before = [agent({ managedPluginIds: ['beta', 'alpha'] }), target];
    const after = [agent({ managedPluginIds: ['gamma', 'beta'] }), target];
    const draft = createPluginDraft(target, before);

    const synced = syncPluginDraft(target, after, draft);

    expect(synced.pluginIds).toEqual(['gamma', 'beta']);
    expect(synced.sourceFingerprint).not.toBe(draft.sourceFingerprint);
    expect(pluginDraftState(target, synced, false).dirty).toBe(false);
  });
});

describe('plugins panel VM custom-to-inherit sync', () => {
  it('refreshes inherited ids while preserving an unsaved mode switch', () => {
    const target = slot({ mode: 'custom', managedPluginIds: ['alpha'] });
    const before = [agent({ managedPluginIds: ['beta', 'alpha'] }), target];
    const after = [agent({ managedPluginIds: ['gamma', 'beta'] }), target];
    const inherited = setPluginDraftMode(createPluginDraft(target, before), target, before, 'inherit');

    const synced = syncPluginDraft(target, after, inherited);

    expect(synced.mode).toBe('inherit');
    expect(synced.pluginIds).toEqual(['gamma', 'beta']);
    expect(pluginDraftState(target, synced, false).dirty).toBe(true);
  });
});

describe('plugins panel VM inherit-to-custom sync', () => {
  it('preserves custom draft choices when the inherited agent changes', () => {
    const target = slot({ mode: 'inherit', managedPluginIds: ['beta', 'alpha'] });
    const before = [agent({ managedPluginIds: ['beta', 'alpha'] }), target];
    const after = [agent({ managedPluginIds: ['gamma', 'beta'] }), target];
    const custom = setPluginDraftMode(createPluginDraft(target, before), target, before, 'custom');
    const edited = togglePluginDraftId(custom, target, plugin({ id: 'mcp-plugin' }));

    const synced = syncPluginDraft(target, after, edited);

    expect(synced.mode).toBe('custom');
    expect(synced.pluginIds).toEqual(['beta', 'alpha', 'mcp-plugin']);
    expect(pluginDraftState(target, synced, false).dirty).toBe(true);
  });
});

describe('plugins panel VM payload hash', () => {
  it('uses the draft hash in the payload so stale ids never ride on a fresh hash', () => {
    const target = slot({ baseHash: 'hash-live', managedPluginIds: ['alpha'] });
    const draft = {
      ...createPluginDraft(target, [agent(), target]),
      baseHash: 'hash-draft',
      pluginIds: ['gamma', 'alpha'],
    };

    expect(buildPluginsAssignArgs(target, draft)).toEqual({
      target: {
        kind: 'template-slot',
        templateName: 'workflow',
        index: 1,
        ref: 'writer',
        baseHash: 'hash-draft',
        mode: 'custom',
      },
      pluginIds: ['gamma', 'alpha'],
    });
  });
});

describe('plugins panel VM invalid gating', () => {
  it('lets an already selected invalid plugin be removed but blocks adding a new one', () => {
    const writer = agent();
    const reviewer = agent({ name: 'reviewer', managedPluginIds: [] });
    const broken = PLUGINS[1];

    const removed = togglePluginDraftId(createPluginDraft(writer, [writer]), writer, broken);
    const untouched = togglePluginDraftId(createPluginDraft(reviewer, [reviewer]), reviewer, broken);

    expect(pluginToggleDisabledReason(writer, createPluginDraft(writer, [writer]), broken)).toBeNull();
    expect(removed.pluginIds).toEqual(['alpha']);
    expect(pluginToggleDisabledReason(reviewer, createPluginDraft(reviewer, [reviewer]), broken)).toBe('invalid');
    expect(untouched.pluginIds).toEqual([]);
  });
});

describe('plugins panel VM MCP payloads', () => {
  it('lists only newly added MCP plugins and keeps payload ids stable', () => {
    const target = slot({ mode: 'custom', managedPluginIds: ['alpha'] });
    const base = createPluginDraft(target, [agent(), target]);
    const next = togglePluginDraftId(base, target, PLUGINS[2]);
    const duped = { ...next, pluginIds: ['mcp-plugin', 'alpha', 'mcp-plugin'] };

    expect(draftMcpPlugins(target, duped, PLUGINS).map((item) => item.id)).toEqual(['mcp-plugin']);
    expect(buildPluginsAssignArgs(target, duped, true)).toEqual({
      target: {
        kind: 'template-slot',
        templateName: 'workflow',
        index: 1,
        ref: 'writer',
        baseHash: 'hash-slot',
        mode: 'custom',
      },
      pluginIds: ['mcp-plugin', 'alpha'],
      acknowledgeMcp: true,
    });
  });
});
