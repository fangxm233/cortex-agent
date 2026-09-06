// input:  plugin catalog view props and language copy
// output: package-manager list, detail tabs, and usage regressions
// pos:    Static plugin package manager regressions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PluginAssignmentTarget, UiPluginCatalogEntry } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { PluginsPanelView, type PluginsPanelViewProps } from './PluginsPanel';

function plugin(over: Partial<UiPluginCatalogEntry> = {}): UiPluginCatalogEntry {
  return {
    id: 'alpha',
    kind: 'portable',
    scope: 'always',
    origin: 'local',
    rootDir: 'plugins/alpha',
    valid: true,
    assignable: true,
    manifest: { source: 'root', name: 'Alpha', version: '1.0.0', description: 'Alpha manifest' },
    skills: [{ name: 'review', description: 'Review a change.', managed: false }],
    mcp: { status: 'missing', servers: [] },
    issues: [],
    ...over,
  };
}

const ALPHA = plugin({
  mcp: {
    status: 'valid',
    servers: [
      { name: 'local', type: 'stdio', summary: { command: './bin/private-server', argsCount: 2, envKeys: ['SECRET_TOKEN'] } },
      { name: 'remote', type: 'streamable-http', summary: { origin: 'https://api.example.com/mcp', headerKeys: ['Authorization'] } },
    ],
  },
  issues: [{ code: 'warn', scope: 'plugin', path: 'plugin.json', message: 'Manifest warning' }],
});

const LEGACY = plugin({
  id: 'broken',
  kind: 'legacy',
  rootDir: 'plugins/broken',
  valid: false,
  assignable: false,
  manifest: { source: 'legacy', name: 'Broken', version: '0.1.0' },
  skills: [],
  issues: [{ code: 'invalid', scope: 'manifest', path: 'plugin.json', message: 'Broken manifest' }],
});

const PLUGINS = [ALPHA, LEGACY];

const TARGETS: PluginAssignmentTarget[] = [
  { kind: 'agent', name: 'writer', editable: true, baseHash: 'h1', managedPluginIds: ['alpha'], unmanagedPluginCount: 0 },
  { kind: 'agent', name: 'reviewer', editable: true, baseHash: 'h2', managedPluginIds: [], unmanagedPluginCount: 0 },
  {
    kind: 'template-slot', templateName: 'workflow', index: 1, ref: 'writer', editable: true,
    baseHash: 'h3', mode: 'custom', managedPluginIds: ['alpha'], unmanagedPluginCount: 0,
  },
  { kind: 'template-shell', templateName: 'bound', editable: false, baseHash: 'h4', readOnlyReason: 'shell-binding' },
];

function render(over: Partial<PluginsPanelViewProps> = {}): string {
  const props: PluginsPanelViewProps = {
    state: 'ready',
    errorMessage: null,
    plugins: PLUGINS,
    targets: TARGETS,
    search: '',
    selectedId: 'alpha',
    tab: 'overview',
    onSearch: () => {},
    onSelect: () => {},
    onTab: () => {},
    ...over,
  };
  return renderToStaticMarkup(<LangProvider><PluginsPanelView {...props} /></LangProvider>);
}

describe('PluginsPanelView list', () => {
  it('lists every installed plugin with its contents summarized', () => {
    const html = render();

    expect(html).toContain('data-plugin-item="alpha"');
    expect(html).toContain('data-plugin-item="broken"');
    expect(html).toContain('1 skills');
    expect(html).toContain('2 MCP');
  });

  it('filters by id, name, and description', () => {
    expect(render({ search: 'broken' })).not.toContain('data-plugin-item="alpha"');
    expect(render({ search: 'Alpha manifest' })).toContain('data-plugin-item="alpha"');
    expect(render({ search: 'nothing-matches' })).toContain('No plugins found');
  });

  it('falls back to the first visible plugin when the selection is filtered away', () => {
    const html = render({ selectedId: 'alpha', search: 'broken' });

    expect(html).toContain('data-plugin-detail="broken"');
  });
});

describe('PluginsPanelView overview tab', () => {
  it('describes the package rather than any assignment control', () => {
    const html = render();

    expect(html).toContain('plugins/alpha');
    expect(html).toContain('root manifest');
    expect(html).toContain('Alpha manifest');
    expect(html).toContain('Manifest warning');
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain('data-action="save"');
  });

  it('reports which agents and template slots use the plugin', () => {
    const html = render();

    expect(html).toContain('data-plugin-usage="agent:writer"');
    expect(html).toContain('data-plugin-usage="slot:workflow:1"');
    expect(html).not.toContain('data-plugin-usage="agent:reviewer"');
  });

  it('says so plainly when nothing references the plugin', () => {
    const html = render({ selectedId: 'broken' });

    expect(html).toContain('Not assigned to any agent or template slot');
  });

  it('surfaces spawn-time scope gating', () => {
    const scoped = plugin({ id: 'delta', scope: 'commission' });
    const html = render({ plugins: [scoped], selectedId: 'delta' });

    expect(html).toContain('data-plugin-scope="commission"');
    expect(html).toContain('only in commission mode');
  });
});

describe('PluginsPanelView skills tab', () => {
  it('shows each skill and where it lives on disk', () => {
    const html = render({ tab: 'skills' });

    expect(html).toContain('data-plugin-skill="review"');
    expect(html).toContain('plugins/alpha/skills/review/SKILL.md');
  });

  it('states when a plugin ships no skills', () => {
    expect(render({ tab: 'skills', selectedId: 'broken' })).toContain('This plugin ships no skills');
  });
});

describe('PluginsPanelView mcp tab', () => {
  it('shows sanitized summaries and never the underlying values', () => {
    const html = render({ tab: 'mcp' });

    expect(html).toContain('./bin/private-server');
    expect(html).toContain('SECRET_TOKEN');
    expect(html).toContain('https://api.example.com/mcp');
    expect(html).not.toContain('Bearer secret');
  });

  it('explains why a legacy package can never declare MCP servers', () => {
    const html = render({ tab: 'mcp', selectedId: 'broken' });

    expect(html).toContain('data-plugin-mcp-unsupported');
    expect(html).toContain('Legacy plugins cannot declare MCP servers');
  });

  it('omits the legacy note for a portable package', () => {
    expect(render({ tab: 'mcp' })).not.toContain('data-plugin-mcp-unsupported');
  });
});

describe('PluginsPanelView states', () => {
  it('renders loading, error, and empty selection states', () => {
    expect(render({ state: 'loading' })).toContain('Loading plugins…');
    expect(render({ state: 'error', errorMessage: 'boom' })).toContain('Failed to load plugins: boom');
    expect(render({ plugins: [] })).toContain('data-plugin-detail-empty');
  });
});
