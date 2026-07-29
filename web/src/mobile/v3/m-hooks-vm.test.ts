// input:  hooks.list overview fixtures
// output: grouping, ordering and declaration-slot regressions
// pos:    Unit tests for the mobile hooks view model
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { HookDetail, HooksOverview } from '@cortex-agent/ui-contract';
import { buildMHooksVm, HOOK_GROUP_ORDER } from './m-hooks-vm';

// Neutral fixtures (守则11): no real hook ids, scripts or project names.
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

function overview(hooks: HookDetail[]): HooksOverview {
  return { hooks, scripts: [], hooksDir: '/home/user/.cortex/hooks' };
}

describe('buildMHooksVm grouping', () => {
  it('returns an empty model for an empty registry', () => {
    const vm = buildMHooksVm(overview([]));
    expect(vm.groups).toEqual([]);
    expect(vm.total).toBe(0);
    expect(vm.enabledCount).toBe(0);
    expect(vm.missingScriptCount).toBe(0);
  });

  it('groups by event namespace in canonical order and drops empty groups', () => {
    const vm = buildMHooksVm(
      overview([
        mk({ id: 'c', event: 'cortex:thread.end', order: 0 }),
        mk({ id: 'a', event: 'agent:pre-tool', order: 1 }),
        mk({ id: 'p', event: 'pi:message_end', order: 2 }),
      ]),
    );
    expect(vm.groups.map((g) => g.key)).toEqual(['agent', 'pi', 'cortex']);
    expect(HOOK_GROUP_ORDER).toContain('cc');
  });

  it('puts template-scoped hooks in their own group regardless of event namespace', () => {
    const vm = buildMHooksVm(
      overview([
        mk({ id: 'template:review:end', event: 'cortex:thread.end', source: 'template-scoped', order: 0 }),
        mk({ id: 'registry-one', event: 'cortex:thread.end', order: 1 }),
      ]),
    );
    expect(vm.groups.map((g) => g.key)).toEqual(['cortex', 'template']);
    expect(vm.groups[0].rows.map((r) => r.id)).toEqual(['registry-one']);
    expect(vm.groups[1].rows.map((r) => r.id)).toEqual(['template:review:end']);
  });

  it('keeps load order (= execution order) inside a group even when the input is shuffled', () => {
    const vm = buildMHooksVm(
      overview([
        mk({ id: 'third', event: 'agent:pre-tool', order: 9 }),
        mk({ id: 'first', event: 'agent:pre-tool', order: 2 }),
        mk({ id: 'second', event: 'agent:post-tool', order: 5 }),
      ]),
    );
    expect(vm.groups[0].rows.map((r) => r.id)).toEqual(['first', 'second', 'third']);
  });

  it('never drops a hook whose event namespace is unknown to the client', () => {
    // Guards a server-side event-vocabulary extension: a read-only inventory that silently hides
    // entries is worse than one with an unlabelled group. The cast models an event this build's
    // HookEvent union does not yet know.
    const vm = buildMHooksVm(overview([mk({ id: 'x', event: 'future:thing' as HookDetail['event'] })]));
    expect(vm.groups.map((g) => g.key)).toEqual(['other']);
    expect(vm.total).toBe(1);
  });

  it('counts totals, enabled entries and missing scripts across all groups', () => {
    const vm = buildMHooksVm(
      overview([
        mk({ id: 'a', event: 'agent:pre-tool', enabled: true, scriptExists: true, order: 0 }),
        mk({ id: 'b', event: 'cc:SessionEnd', enabled: false, scriptExists: false, order: 1 }),
        mk({ id: 'c', event: 'pi:message_end', enabled: true, scriptExists: null, order: 2 }),
      ]),
    );
    expect(vm.total).toBe(3);
    expect(vm.enabledCount).toBe(2);
    expect(vm.missingScriptCount).toBe(1);
  });
});

describe('buildMHooksVm rows', () => {
  it('exposes the list slots and a key that stays unique across duplicate ids', () => {
    const vm = buildMHooksVm(
      overview([
        mk({
          id: 'row-one',
          event: 'agent:pre-tool',
          source: 'user',
          enabled: false,
          mountsOn: ['claude', 'pi'],
          order: 4,
        }),
        mk({ id: 'row-one', event: 'agent:post-tool', order: 7 }),
      ]),
    );
    const [first, second] = vm.groups[0].rows;
    expect(first).toMatchObject({
      id: 'row-one',
      event: 'agent:pre-tool',
      source: 'user',
      enabled: false,
      mountsOn: ['claude', 'pi'],
      scriptMissing: false,
    });
    expect(first.key).not.toBe(second.key);
  });

  it('flags a missing script only when a declared script is absent on disk', () => {
    const vm = buildMHooksVm(
      overview([
        mk({ id: 'missing', event: 'agent:pre-tool', scriptExists: false, order: 0 }),
        mk({ id: 'present', event: 'agent:pre-tool', scriptExists: true, order: 1 }),
        mk({ id: 'command-based', event: 'agent:pre-tool', scriptExists: null, order: 2 }),
      ]),
    );
    expect(vm.groups[0].rows.map((r) => r.scriptMissing)).toEqual([true, false, false]);
  });
});

describe('buildMHooksVm declaration detail', () => {
  it('maps a regex matcher, a script run, timeout, scope and blocking', () => {
    const vm = buildMHooksVm(
      overview([
        mk({
          id: 'guard',
          event: 'agent:pre-tool',
          matcher: 'Edit|Write',
          run: { script: 'guard.mjs', command: null, timeoutSec: 10 },
          scope: { backends: ['claude', 'pi'], requiresTool: 'Edit' },
          blocking: { mode: 'webhook', ttlMin: 30 },
          result: 'hook-result',
          source: 'managed',
          version: '2026.7.1',
          fileName: '01-guard.json',
          order: 3,
          mountsOn: ['claude', 'pi'],
          appliesAt: 'next-agent',
          scriptExists: true,
        }),
      ]),
    );
    expect(vm.groups[0].rows[0].detail).toEqual({
      id: 'guard',
      event: 'agent:pre-tool',
      matcher: { kind: 'regex', value: 'Edit|Write' },
      run: { kind: 'script', value: 'guard.mjs', missing: false },
      timeoutSec: 10,
      backends: ['claude', 'pi'],
      requiresTool: 'Edit',
      result: 'hook-result',
      blocking: { mode: 'webhook', ttlMin: 30 },
      source: 'managed',
      version: '2026.7.1',
      fileName: '01-guard.json',
      order: 3,
      mountsOn: ['claude', 'pi'],
      appliesAt: 'next-agent',
      template: null,
      phase: null,
    });
  });

  it('flattens equality filters into printable key/value entries', () => {
    const vm = buildMHooksVm(
      overview([
        mk({
          id: 'bus',
          event: 'cortex:thread.end',
          matcherFilters: { template: 'review', depth: 2, final: true, tag: null },
          appliesAt: 'server-restart',
        }),
      ]),
    );
    expect(vm.groups[0].rows[0].detail.matcher).toEqual({
      kind: 'filters',
      entries: [
        { key: 'template', value: 'review' },
        { key: 'depth', value: '2' },
        { key: 'final', value: 'true' },
        { key: 'tag', value: 'null' },
      ],
    });
    expect(vm.groups[0].rows[0].detail.appliesAt).toBe('server-restart');
  });

  it('reports a command run and a missing script run distinctly', () => {
    const vm = buildMHooksVm(
      overview([
        mk({
          id: 'cmd',
          event: 'agent:pre-tool',
          run: { script: null, command: 'node hooks/x.mjs', timeoutSec: null },
          order: 0,
        }),
        mk({
          id: 'gone',
          event: 'agent:pre-tool',
          run: { script: 'gone.mjs', command: null, timeoutSec: 5 },
          scriptExists: false,
          order: 1,
        }),
      ]),
    );
    const [cmd, gone] = vm.groups[0].rows;
    expect(cmd.detail.run).toEqual({ kind: 'command', value: 'node hooks/x.mjs', missing: false });
    expect(cmd.detail.timeoutSec).toBeNull();
    expect(gone.detail.run).toEqual({ kind: 'script', value: 'gone.mjs', missing: true });
  });

  it('reports an absent matcher, scope and run without inventing values', () => {
    const vm = buildMHooksVm(
      overview([
        mk({ id: 'template:review:end', event: 'cortex:thread.end', source: 'template-scoped', template: 'review', phase: 'end' }),
      ]),
    );
    const detail = vm.groups[0].rows[0].detail;
    expect(detail.matcher).toBeNull();
    expect(detail.backends).toBeNull();
    expect(detail.requiresTool).toBeNull();
    expect(detail.run).toEqual({ kind: 'none' });
    expect(detail.template).toBe('review');
    expect(detail.phase).toBe('end');
  });
});
