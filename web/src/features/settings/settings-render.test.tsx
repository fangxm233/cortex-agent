import { describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup as renderRaw } from 'react-dom/server';
import { LangProvider } from '@/i18n';
import type { ConfigSnapshot, ThreadTemplateEntry } from '@cortex-agent/ui-contract';

// The panels now consume useVocab() → wrap every render in LangProvider (defaults to the en vocab,
// matching the English assertions below).
function renderToStaticMarkup(el: ReactElement): string {
  return renderRaw(createElement(LangProvider, null, el));
}
import {
  PlatformPanel,
  ProfilesPanel,
  MachinesPanel,
  TemplatesPanel,
  McpPanel,
  NotificationsPanel,
  HooksPanel,
  AdvancedPanel,
} from './SettingsPanels';

// react-dom/server render checks for the pure presentational panels (they take a plain
// ConfigSnapshot). Asserts the 1:1 structure renders REAL snapshot data + the honest placeholders.
// The Budget panel + modal shell (tRPC hooks) are covered by the live harness.

const snap: ConfigSnapshot = {
  budget: { daily_usd: 10, monthly_usd: 300 },
  profiles: {
    defaultProfile: 'plan',
    profiles: [
      { name: 'plan', model: 'claude-sonnet-4', backend: 'claude', mode: 'print' },
      { name: 'execute', model: 'claude-sonnet-4', backend: 'claude', mode: null },
    ],
  },
  machines: [
    { name: 'lab2', cortexPath: '/home/x/Cortex', gpuCount: 2, ssh: false, win: false },
    { name: 'gpu-01', cortexPath: '/home/x/Cortex', gpuCount: 8, ssh: true, win: false },
  ],
  mcp: { servers: ['cortex-core', 'cortex-slack'] },
  threadTemplates: { agents: ['coder'], templates: ['coder-review'], shells: ['bash'] },
  hooks: ['rules-loader.mjs', 'tasks-yaml-guard.mjs'],
  env: [
    { key: 'SLACK_BOT_TOKEN', present: true, masked: '••••••••' },
    { key: 'ANTHROPIC_API_KEY', present: true, masked: '••••••••' },
    { key: 'CORTEX_MACHINE', present: true, masked: '••••••••' },
    { key: 'DEBUG', present: true, masked: '••••••••' },
  ],
};

describe('settings panels — real data render', () => {
  it('Platform: masks present env, groups Messaging/API/Daemon, never leaks cleartext', () => {
    const html = renderToStaticMarkup(<PlatformPanel snapshot={snap} />);
    expect(html).toContain('Messaging platforms');
    expect(html).toContain('SLACK_BOT_TOKEN');
    expect(html).toContain('ANTHROPIC_API_KEY');
    expect(html).toContain('CORTEX_MACHINE');
    expect(html).toContain('••••••••');
    // presence-derived pill, not fabricated "connected · socket mode"
    expect(html).toContain('configured');
  });

  it('Profiles: real defaultProfile + rows, FALLBACK column omitted honestly', () => {
    const html = renderToStaticMarkup(<ProfilesPanel snapshot={snap} />);
    expect(html).toContain('plan');
    expect(html).toContain('execute');
    expect(html).toContain('claude-sonnet-4');
    expect(html).toContain('fallback is not in the config.get contract');
  });

  it('Machines: real name/path/gpu; ssh presence not raw host; runtime status omitted', () => {
    const html = renderToStaticMarkup(<MachinesPanel snapshot={snap} />);
    expect(html).toContain('lab2');
    expect(html).toContain('gpu-01');
    expect(html).toContain('— local'); // ssh:false
    expect(html).toContain('configured'); // ssh:true
    expect(html).toContain('presence flag only');
  });

  it('Templates: real basenames grouped, no fabricated chips (fallback — no entries)', () => {
    const html = renderToStaticMarkup(<TemplatesPanel snapshot={snap} />);
    expect(html).toContain('coder-review');
    expect(html).toContain('coder');
    expect(html).toContain('bash');
  });

  it('Templates: entries prop renders rich template content with kind/name/description/key-count', () => {
    const entries: ThreadTemplateEntry[] = [
      {
        kind: 'template',
        name: 'coder-review',
        description: 'Code review orchestration',
        body: { entryAgent: 'coder', agents: {}, transitions: {} },
      },
      {
        kind: 'agent',
        name: 'coder',
        description: null,
        body: { profile: 'execute', directive: 'Write code', stages: [], tools: [], pluginDirs: [] },
      },
      {
        kind: 'shell',
        name: 'bash',
        description: 'Bash worker shell',
        body: null,
      },
    ];
    const html = renderToStaticMarkup(<TemplatesPanel snapshot={snap} entries={entries} />);
    // kind badges
    expect(html).toContain('template');
    expect(html).toContain('agent');
    expect(html).toContain('shell');
    // names
    expect(html).toContain('coder-review');
    expect(html).toContain('coder');
    expect(html).toContain('bash');
    // description present
    expect(html).toContain('Code review orchestration');
    expect(html).toContain('Bash worker shell');
    // null description → honest em-dash
    expect(html).toContain('—');
    // body key count for template entry (3 keys)
    expect(html).toContain('>3<');
    // body null → key count — (for shell)
    // entry count badge
    expect(html).toContain('3 entries');
    // real content note
    expect(html).toContain('Real content from thread-templates');
  });

  it('MCP: real server names, variant toggle inert', () => {
    const html = renderToStaticMarkup(<McpPanel snapshot={snap} />);
    expect(html).toContain('cortex-core');
    expect(html).toContain('cortex-slack');
  });

  it('Notifications: toggles reflect env presence; approval note fixed-on', () => {
    const html = renderToStaticMarkup(<NotificationsPanel snapshot={snap} />);
    expect(html).toContain('CORTEX_TURN_NOTIFY');
    expect(html).toContain('Approval reminders are always on');
  });

  it('Notifications: channel routing shows SLACK_ADMIN_CHANNEL key presence when Slack configured', () => {
    const snapWithSlack: ConfigSnapshot = {
      ...snap,
      env: [
        { key: 'SLACK_BOT_TOKEN', present: true, masked: '••••••••' },
        { key: 'SLACK_ADMIN_CHANNEL', present: true, masked: '••••••••' },
      ],
    };
    const html = renderToStaticMarkup(<NotificationsPanel snapshot={snapWithSlack} />);
    expect(html).toContain('SLACK_ADMIN_CHANNEL');
    // channel value shown as mask — never cleartext
    expect(html).toContain('••••••••');
  });

  it('Notifications: channel routing omitted when platform not configured', () => {
    const snapNoSlack: ConfigSnapshot = {
      ...snap,
      env: [],
    };
    const html = renderToStaticMarkup(<NotificationsPanel snapshot={snapNoSlack} />);
    // channel detail not shown when Slack absent
    expect(html).not.toContain('SLACK_ADMIN_CHANNEL');
  });

  it('Notifications: honest placeholder states no history scope (no fabricated count)', () => {
    const html = renderToStaticMarkup(<NotificationsPanel snapshot={snap} />);
    expect(html).toContain('Recent notifications');
    expect(html).toContain('no history scope');
    expect(html).toContain('no file persistence');
    // confirms no fabricated numeric count or list items
    expect(html).not.toMatch(/\d+ notification/);
  });

  it('Hooks: real hook filenames listed', () => {
    const html = renderToStaticMarkup(<HooksPanel snapshot={snap} />);
    expect(html).toContain('rules-loader.mjs');
    expect(html).toContain('tasks-yaml-guard.mjs');
  });

  it('Advanced: flag toggles reflect env presence', () => {
    const html = renderToStaticMarkup(<AdvancedPanel snapshot={snap} />);
    expect(html).toContain('DEBUG');
    expect(html).toContain('CORTEX_SERVER_UPDATE_DISABLE');
  });
});

// Wired affordances (task b983): when a handler is passed the panel renders the REAL control —
// a default-profile <select> (config.set write) and clickable Reconnect / Add-machine buttons
// (approvals.request gate). Handlers are plain functions, so react-dom/server needs no tRPC provider.
describe('settings panels — wired affordances (b983)', () => {
  it('Profiles: renders a real default-profile select with an option per profile', () => {
    const html = renderToStaticMarkup(<ProfilesPanel snapshot={snap} onSetDefaultProfile={() => {}} />);
    expect(html).toContain('data-default-profile-select');
    expect(html).toContain('<option');
    expect(html).toContain('>plan<');
    expect(html).toContain('>execute<');
  });

  it('Profiles: stays inert (no select) when no handler is wired', () => {
    const html = renderToStaticMarkup(<ProfilesPanel snapshot={snap} />);
    expect(html).not.toContain('data-default-profile-select');
  });

  it('Platform: Reconnect becomes an approval-gated button for both platforms when wired', () => {
    const html = renderToStaticMarkup(<PlatformPanel snapshot={snap} onReconnect={() => {}} />);
    expect(html).toContain('data-reconnect="slack"');
    expect(html).toContain('data-reconnect="feishu"');
    // honest: it queues an approval, it does not bare-execute
    expect(html).toContain('never runs directly');
  });

  it('Machines: Add-machine becomes an approval-gated button when wired', () => {
    const html = renderToStaticMarkup(<MachinesPanel snapshot={snap} onAddMachine={() => {}} />);
    expect(html).toContain('data-add-machine');
    expect(html).toContain('never writes machines.json directly');
  });
});
