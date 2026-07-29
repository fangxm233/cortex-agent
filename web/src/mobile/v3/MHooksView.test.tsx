// input:  hooks view model, copy and sheet selection
// output: grouped-row and declaration-sheet regressions
// pos:    Mobile hooks list and sheet contract
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HookDetail, HooksOverview } from '@cortex-agent/ui-contract';
import { buildMHooksVm, type MHookRow } from './m-hooks-vm';
import { MHooksView, type MHooksCopy } from './MHooksView';

const copy: MHooksCopy = {
  title: 'Hooks',
  enabledWord: 'enabled-word',
  countUnit: 'count-unit',
  group: {
    agent: 'GROUP-AGENT',
    cc: 'GROUP-CC',
    pi: 'GROUP-PI',
    cortex: 'GROUP-CORTEX',
    template: 'GROUP-TEMPLATE',
    other: 'GROUP-OTHER',
  },
  enabled: 'ON-LABEL',
  disabled: 'OFF-LABEL',
  scriptMissing: 'SCRIPT-MISSING',
  empty: 'EMPTY-STATE',
  editDesktop: 'EDIT-ON-DESKTOP',
  none: '—',
  secondUnit: 's',
  minuteUnit: 'min',
  field: {
    event: 'F-EVENT',
    matcher: 'F-MATCHER',
    filters: 'F-FILTERS',
    script: 'F-SCRIPT',
    command: 'F-COMMAND',
    run: 'F-RUN',
    timeout: 'F-TIMEOUT',
    backends: 'F-BACKENDS',
    requiresTool: 'F-REQUIRES-TOOL',
    result: 'F-RESULT',
    blocking: 'F-BLOCKING',
    source: 'F-SOURCE',
    version: 'F-VERSION',
    fileName: 'F-FILENAME',
    order: 'F-ORDER',
    mountsOn: 'F-MOUNTS-ON',
    appliesAt: 'F-APPLIES-AT',
    template: 'F-TEMPLATE',
    phase: 'F-PHASE',
  },
  applies: { 'next-agent': 'APPLIES-NEXT-AGENT', 'server-restart': 'APPLIES-RESTART' },
  sheetFooter: 'SHEET-FOOTER',
};

function mk(p: Partial<HookDetail> & { id: string; event: HookDetail['event'] }): HookDetail {
  return {
    id: p.id,
    event: p.event,
    matcher: p.matcher ?? null,
    matcherFilters: p.matcherFilters ?? null,
    run: p.run ?? { script: null, command: null, timeoutSec: null },
    scope: p.scope ?? null,
    blocking: p.blocking ?? null,
    result: p.result ?? null,
    enabled: p.enabled ?? true,
    source: p.source ?? 'managed',
    version: p.version ?? null,
    fileName: p.fileName ?? null,
    order: p.order ?? 0,
    mountsOn: p.mountsOn ?? [],
    legalResults: p.legalResults ?? [],
    appliesAt: p.appliesAt ?? 'next-agent',
    scriptExists: p.scriptExists ?? null,
    editable: p.editable ?? false,
    template: p.template ?? null,
    phase: p.phase ?? null,
  };
}

const hooks: HookDetail[] = [
  mk({
    id: 'guard-hook',
    event: 'agent:pre-tool',
    matcher: 'Edit|Write',
    run: { script: 'guard.mjs', command: null, timeoutSec: 10 },
    scope: { backends: ['claude', 'pi'], requiresTool: 'Edit' },
    blocking: { mode: 'webhook', ttlMin: 30 },
    result: 'hook-result',
    version: '2026.7.1',
    fileName: '01-guard.json',
    order: 0,
    mountsOn: ['claude', 'pi'],
    scriptExists: true,
  }),
  mk({
    id: 'broken-hook',
    event: 'pi:message_end',
    source: 'user',
    enabled: false,
    run: { script: 'gone.mjs', command: null, timeoutSec: null },
    order: 1,
    mountsOn: ['pi'],
    scriptExists: false,
  }),
  mk({
    id: 'template:review:end',
    event: 'cortex:thread.end',
    source: 'template-scoped',
    order: 2,
    mountsOn: ['server'],
    appliesAt: 'server-restart',
    template: 'review',
    phase: 'end',
  }),
];

function overview(list: HookDetail[]): HooksOverview {
  return { hooks: list, scripts: [], hooksDir: '/home/user/.cortex/hooks' };
}

function render(list: HookDetail[], sheetRow: MHookRow | null = null): string {
  return renderToStaticMarkup(
    <MHooksView
      vm={buildMHooksVm(overview(list))}
      copy={copy}
      sheetRow={sheetRow}
      onBack={() => {}}
      onOpenHook={() => {}}
      onCloseSheet={() => {}}
    />,
  );
}

function rowOf(list: HookDetail[], id: string): MHookRow {
  const row = buildMHooksVm(overview(list))
    .groups.flatMap((g) => g.rows)
    .find((r) => r.id === id);
  if (!row) throw new Error(`fixture row ${id} missing`);
  return row;
}

describe('MHooksView list', () => {
  it('renders one group label per present namespace and none for absent ones', () => {
    const html = render(hooks);
    for (const label of ['GROUP-AGENT', 'GROUP-PI', 'GROUP-TEMPLATE']) {
      expect(html).toContain(label);
    }
    for (const label of ['GROUP-CC', 'GROUP-CORTEX', 'GROUP-OTHER']) {
      expect(html).not.toContain(label);
    }
  });

  it('renders identity, event, source, enabled state and mount badges on every row', () => {
    const html = render(hooks);
    for (const value of [
      'guard-hook', 'agent:pre-tool', 'managed', 'ON-LABEL',
      'broken-hook', 'pi:message_end', 'user', 'OFF-LABEL',
      'template:review:end', 'cortex:thread.end', 'template-scoped',
      'claude', 'pi', 'server',
    ]) {
      expect(html).toContain(value);
    }
  });

  it('flags only the hook whose declared script is missing on disk', () => {
    expect(render(hooks).match(/SCRIPT-MISSING/g)).toHaveLength(1);
    expect(render([hooks[0]])).not.toContain('SCRIPT-MISSING');
  });

  it('renders the localized empty state instead of rows or group labels', () => {
    const html = render([]);
    expect(html).toContain('EMPTY-STATE');
    expect(html).not.toContain('GROUP-AGENT');
    expect(html).not.toContain('guard-hook');
  });

  it('keeps the list read-only: the desktop-edit hint is present and no form control is rendered', () => {
    const html = render(hooks);
    expect(html).toContain('EDIT-ON-DESKTOP');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('<textarea');
  });
});

describe('MHooksView declaration sheet', () => {
  it('shows no declaration fields while no row is selected', () => {
    const html = render(hooks);
    for (const label of ['F-MATCHER', 'F-TIMEOUT', 'F-FILENAME', 'SHEET-FOOTER']) {
      expect(html).not.toContain(label);
    }
  });

  it('shows the complete declaration of the selected row', () => {
    const html = render(hooks, rowOf(hooks, 'guard-hook'));
    for (const value of [
      'F-EVENT', 'agent:pre-tool',
      'F-MATCHER', 'Edit|Write',
      'F-SCRIPT', 'guard.mjs',
      'F-TIMEOUT', '10s',
      'F-BACKENDS', 'F-REQUIRES-TOOL', 'Edit',
      'F-RESULT', 'hook-result',
      'F-BLOCKING', 'webhook', '30min',
      'F-SOURCE', 'managed',
      'F-VERSION', '2026.7.1',
      'F-FILENAME', '01-guard.json',
      'F-ORDER',
      'F-MOUNTS-ON',
      'F-APPLIES-AT', 'APPLIES-NEXT-AGENT',
      'SHEET-FOOTER',
    ]) {
      expect(html).toContain(value);
    }
  });

  it('renders cortex equality filters instead of a regex matcher', () => {
    const filtered = [
      mk({
        id: 'bus-hook',
        event: 'cortex:thread.end',
        matcherFilters: { template: 'review', final: true },
        appliesAt: 'server-restart',
      }),
    ];
    const html = render(filtered, rowOf(filtered, 'bus-hook'));
    expect(html).toContain('F-FILTERS');
    expect(html).toContain('template');
    expect(html).toContain('review');
    expect(html).toContain('final');
    expect(html).toContain('true');
    expect(html).toContain('APPLIES-RESTART');
  });

  it('shows the template owner and phase for a template-scoped hook and gaps for absent fields', () => {
    const html = render(hooks, rowOf(hooks, 'template:review:end'));
    expect(html).toContain('F-TEMPLATE');
    expect(html).toContain('review');
    expect(html).toContain('F-PHASE');
    expect(html).toContain('—');
    expect(html).not.toContain('F-VERSION');
  });

  it('marks a missing script inside the sheet too', () => {
    const html = render(hooks, rowOf(hooks, 'broken-hook'));
    expect(html).toContain('gone.mjs');
    expect(html).toContain('SCRIPT-MISSING');
  });
});
