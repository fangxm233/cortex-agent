import { describe, expect, it } from 'vitest';
import type { PluginAssignmentTarget, UiPluginCatalogEntry } from '@cortex-agent/ui-contract';
import {
  buildPluginsAssignArgs,
  createPluginDraft,
  draftMcpPlugins,
  pluginDraftState,
  pluginTargetKey,
  pluginToggleDisabledReason,
  pluginUsedBy,
  resolvePluginTarget,
  syncPluginDraft,
  togglePluginDraftId,
} from './plugin-assign-vm';

function plugin(over: Partial<UiPluginCatalogEntry> = {}): UiPluginCatalogEntry {
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
  it('keys environment targets and falls back to the first live target', () => {
    const targets = [agent(), agent({ name: 'reviewer' })];

    expect(pluginTargetKey(targets[0])).toBe('agent:writer');
    expect(resolvePluginTarget(targets, 'agent:reviewer')).toEqual(targets[1]);
    expect(resolvePluginTarget(targets, 'missing')).toEqual(targets[0]);
  });
});

describe('plugins panel VM lifecycle safety', () => {
  it('preserves a dirty draft as conflicted when its target hash changes', () => {
    const initial = agent({ baseHash: 'hash-old', managedPluginIds: ['alpha'] });
    const changed = agent({ baseHash: 'hash-new', managedPluginIds: ['beta', 'alpha'] });
    const dirty = togglePluginDraftId(createPluginDraft(initial), initial, plugin({ id: 'beta' }));

    const synced = syncPluginDraft(changed, dirty);
    const state = pluginDraftState(changed, synced, false);

    expect(synced).toBe(dirty);
    expect(state).toEqual({ dirty: true, conflicted: true, canSave: false, canReset: true });
  });

  it('refreshes a clean draft when its target hash changes', () => {
    const initial = agent({ baseHash: 'hash-old', managedPluginIds: ['alpha'] });
    const changed = agent({ baseHash: 'hash-new', managedPluginIds: ['beta'] });

    const synced = syncPluginDraft(changed, createPluginDraft(initial));

    expect(synced.baseHash).toBe('hash-new');
    expect(synced.pluginIds).toEqual(['beta']);
  });
});

describe('plugins panel VM payload hash', () => {
  it('uses the draft hash in the payload so stale ids never ride on a fresh hash', () => {
    const target = agent({ baseHash: 'hash-live', managedPluginIds: ['alpha'] });
    const draft = { ...createPluginDraft(target), baseHash: 'hash-draft', pluginIds: ['gamma', 'alpha'] };

    expect(buildPluginsAssignArgs(target, draft)).toEqual({
      target: { kind: 'agent', name: 'writer', baseHash: 'hash-draft' },
      pluginIds: ['gamma', 'alpha'],
    });
  });
});

describe('plugins panel VM invalid gating', () => {
  it('lets an already selected invalid plugin be removed but blocks adding a new one', () => {
    const writer = agent();
    const reviewer = agent({ name: 'reviewer', managedPluginIds: [] });
    const broken = PLUGINS[1];

    const removed = togglePluginDraftId(createPluginDraft(writer), writer, broken);
    const untouched = togglePluginDraftId(createPluginDraft(reviewer), reviewer, broken);

    expect(pluginToggleDisabledReason(writer, createPluginDraft(writer), broken)).toBeNull();
    expect(removed.pluginIds).toEqual(['alpha']);
    expect(pluginToggleDisabledReason(reviewer, createPluginDraft(reviewer), broken)).toBe('invalid');
    expect(untouched.pluginIds).toEqual([]);
  });
});

describe('plugins panel VM MCP payloads', () => {
  it('lists only newly added MCP plugins and keeps payload ids stable', () => {
    const target = agent({ managedPluginIds: ['alpha'] });
    const next = togglePluginDraftId(createPluginDraft(target), target, PLUGINS[2]);
    const duped = { ...next, pluginIds: ['mcp-plugin', 'alpha', 'mcp-plugin'] };

    expect(draftMcpPlugins(target, duped, PLUGINS).map((item) => item.id)).toEqual(['mcp-plugin']);
    expect(buildPluginsAssignArgs(target, duped)).toEqual({
      target: { kind: 'agent', name: 'writer', baseHash: 'hash-agent' },
      pluginIds: ['mcp-plugin', 'alpha'],
    });
  });
});

describe('plugins panel VM usage', () => {
  it('lists the environments that reference a plugin', () => {
    const targets = [agent(), agent({ name: 'reviewer', managedPluginIds: ['beta'] })];

    expect(pluginUsedBy(targets, 'alpha').map((target) => target.name)).toEqual(['writer']);
    expect(pluginUsedBy(targets, 'gamma')).toEqual([]);
  });
});
