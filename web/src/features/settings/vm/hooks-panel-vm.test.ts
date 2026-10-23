import { describe, it, expect } from 'vitest';
import type { HookDetail } from '@cortex-agent/ui-contract';
import {
  buildHookCreateArgs,
  buildHookUpdateArgs,
  countHooksByFilter,
  emptyHookForm,
  filterHooks,
  formStateFromDetail,
  formatFilterValue,
  groupHooks,
  hasClaudeMountGap,
  hookCapability,
  hookEventOptions,
  hookNamespace,
  isHookFormDirty,
  isResultLocked,
  legalResultsForEvent,
  matcherKindForEvent,
  parseFilterValue,
  reconcileResultForEvent,
  resolveSelectedHookId,
  validateHookForm,
  validateMatcherRegex,
} from './hooks-panel-vm';

function hook(over: Partial<HookDetail> = {}): HookDetail {
  return {
    id: 'sample',
    event: 'agent:pre-tool',
    matcher: null,
    matcherFilters: null,
    run: { script: 'sample.mjs', command: null, timeoutSec: 10 },
    scope: null,
    blocking: null,
    result: null,
    enabled: true,
    source: 'builtin',
    overridden: false,
    version: null,
    fileName: '01-sample.json',
    order: 0,
    mountsOn: ['claude', 'pi'],
    legalResults: ['none'],
    appliesAt: 'next-agent',
    scriptExists: true,
    editable: false,
    template: null,
    phase: null,
    ...over,
  };
}

describe('hooks-panel-vm / filters + grouping', () => {
  const hooks: HookDetail[] = [
    hook({ id: 'a-pre', event: 'agent:pre-tool', order: 0, mountsOn: ['claude', 'pi'] }),
    hook({ id: 'a-turn', event: 'agent:turn-end', order: 1, mountsOn: ['pi'] }),
    hook({ id: 'cc-perm', event: 'cc:PermissionRequest', order: 2, mountsOn: ['claude'] }),
    hook({ id: 'pi-hdr', event: 'pi:before_provider_headers', order: 3, mountsOn: ['pi'] }),
    hook({ id: 'cx-end', event: 'cortex:session.messageEnd', order: 4, mountsOn: ['server'] }),
    hook({ id: 'cx-new', event: 'cortex:session.new', order: 5, mountsOn: ['server'], source: 'user' }),
  ];

  it('agent filters on the declaration namespace, not the mount target', () => {
    expect(filterHooks(hooks, 'agent', '').map((h) => h.id)).toEqual(['a-pre', 'a-turn']);
  });

  it('claude / pi / server filter on the real mount targets', () => {
    expect(filterHooks(hooks, 'claude', '').map((h) => h.id)).toEqual(['a-pre', 'cc-perm']);
    expect(filterHooks(hooks, 'pi', '').map((h) => h.id)).toEqual(['a-pre', 'a-turn', 'pi-hdr']);
    expect(filterHooks(hooks, 'server', '').map((h) => h.id)).toEqual(['cx-end', 'cx-new']);
  });

  it('search matches id, event, filename, script and command, case-insensitively', () => {
    expect(filterHooks(hooks, 'all', 'SESSION.MESSAGEEND').map((h) => h.id)).toEqual(['cx-end']);
    expect(filterHooks(hooks, 'all', 'pi-hdr').map((h) => h.id)).toEqual(['pi-hdr']);
    const withCommand = [hook({ id: 'cmd', run: { script: null, command: 'printf hello', timeoutSec: null } })];
    expect(filterHooks(withCommand, 'all', 'printf').map((h) => h.id)).toEqual(['cmd']);
    expect(filterHooks(hooks, 'all', '   ').map((h) => h.id)).toHaveLength(6);
  });

  it('search composes with the active chip', () => {
    expect(filterHooks(hooks, 'pi', 'agent:').map((h) => h.id)).toEqual(['a-pre', 'a-turn']);
  });

  it('counts each chip against the search-filtered set', () => {
    expect(countHooksByFilter(hooks, '')).toEqual({
      all: 6, agent: 2, claude: 2, pi: 3, server: 2,
    });
    expect(countHooksByFilter(hooks, 'messageend')).toEqual({
      all: 1, agent: 0, claude: 0, pi: 0, server: 1,
    });
  });

  it('namespaces a hook by event prefix', () => {
    expect(hookNamespace(hooks[0])).toBe('agent');
    expect(hookNamespace(hooks[2])).toBe('cc');
    expect(hookNamespace(hooks[3])).toBe('pi');
    expect(hookNamespace(hooks[4])).toBe('cortex');
    expect(hookNamespace(hooks[5])).toBe('cortex');
  });

  it('groups valid server namespaces in a fixed order, dropping empty groups, ordered by load order', () => {
    const groups = groupHooks(hooks);
    expect(groups.map((g) => g.key)).toEqual(['agent', 'cc', 'pi', 'cortex']);
    expect(groups[0].hooks.map((h) => h.id)).toEqual(['a-pre', 'a-turn']);
    expect(groupHooks(filterHooks(hooks, 'claude', '')).map((g) => g.key)).toEqual(['agent', 'cc']);
    expect(groupHooks([])).toEqual([]);
  });

  it('sorts each group by load order even when the input is shuffled', () => {
    const shuffled = [hooks[1], hooks[0]];
    expect(groupHooks(shuffled)[0].hooks.map((h) => h.id)).toEqual(['a-pre', 'a-turn']);
  });

  it('keeps an unknown future namespace visible in the final other group', () => {
    const future = hook({ id: 'future', event: 'future:thing' as HookDetail['event'] });
    expect(hookNamespace(future)).toBe('other');
    expect(groupHooks([future]).map((group) => group.key)).toEqual(['other']);
  });

  it('resolveSelectedHookId keeps a live selection and otherwise falls back to the first visible row', () => {
    expect(resolveSelectedHookId(hooks, hooks, 'cc-perm')).toBe('cc-perm');
    expect(resolveSelectedHookId(hooks, hooks, 'gone')).toBe('a-pre');
    expect(resolveSelectedHookId(hooks, hooks, null)).toBe('a-pre');
    expect(resolveSelectedHookId([], [], 'a-pre')).toBeNull();
  });

  it('resolveSelectedHookId keeps a selection the current filter hides, so an edit is not lost', () => {
    const onlyServer = filterHooks(hooks, 'server', '');
    expect(resolveSelectedHookId(hooks, onlyServer, 'a-pre')).toBe('a-pre');
    // ...but a selection that no longer exists lands on the first row the filter DOES show
    expect(resolveSelectedHookId(hooks, onlyServer, 'deleted')).toBe('cx-end');
    expect(resolveSelectedHookId(hooks, [], null)).toBe('a-pre');
  });
});

describe('hooks-panel-vm / capability by source', () => {

  it('never grants editing to a source the server did not mark editable', () => {
    expect(hookCapability(hook({ source: 'user', editable: false })).canEdit).toBe(false);
  });
});

describe('hooks-panel-vm / mount gap', () => {
  it('flags agent:* declarations that never reach Claude', () => {
    expect(hasClaudeMountGap(hook({ event: 'agent:turn-end', mountsOn: ['pi'] }))).toBe(true);
    expect(hasClaudeMountGap(hook({ event: 'agent:pre-tool', mountsOn: ['claude', 'pi'] }))).toBe(false);
  });

  it('does not flag cc: / pi: / cortex: declarations — they name their target', () => {
    expect(hasClaudeMountGap(hook({ event: 'pi:tool_call', mountsOn: ['pi'] }))).toBe(false);
    expect(hasClaudeMountGap(hook({ event: 'cortex:session.messageEnd', mountsOn: ['server'] }))).toBe(false);
    expect(hasClaudeMountGap(hook({ event: 'cc:Stop', mountsOn: ['claude'] }))).toBe(false);
  });
});

describe('hooks-panel-vm / result legality', () => {

  it('locks every other event down to none', () => {
    expect(legalResultsForEvent('agent:pre-tool')).toEqual(['none']);
    expect(legalResultsForEvent('cortex:schedule.fired')).toEqual(['none']);
    expect(isResultLocked('agent:pre-tool')).toBe(true);
    expect(isResultLocked('cortex:session.messageEnd')).toBe(false);
  });

  it('resets an illegal result when the event changes, and keeps a legal one', () => {
    expect(reconcileResultForEvent('stdout-as-prompt', 'agent:pre-tool')).toBe('none');
    expect(reconcileResultForEvent('stdout-as-prompt', 'cortex:session.messageEnd')).toBe('stdout-as-prompt');
    expect(reconcileResultForEvent('none', 'cortex:session.messageEnd')).toBe('none');
  });
});

describe('hooks-panel-vm / matcher', () => {
  it('picks the filter editor for cortex:* and the regex input everywhere else', () => {
    expect(matcherKindForEvent('cortex:session.messageEnd')).toBe('filters');
    expect(matcherKindForEvent('agent:pre-tool')).toBe('regex');
    expect(matcherKindForEvent('cc:Stop')).toBe('regex');
    expect(matcherKindForEvent('pi:tool_call')).toBe('regex');
  });

  it('validates the regex the same way the loader does', () => {
    expect(validateMatcherRegex('Edit|Write')).toBeNull();
    expect(validateMatcherRegex('')).toBeNull();
    expect(validateMatcherRegex('Edit(')).toBeTruthy();
  });

  it('round-trips filter values through their typed form', () => {
    expect(parseFilterValue('scheduled')).toBe('scheduled');
    expect(parseFilterValue('true')).toBe(true);
    expect(parseFilterValue('false')).toBe(false);
    expect(parseFilterValue('null')).toBeNull();
    expect(parseFilterValue('42')).toBe(42);
    expect(parseFilterValue('"42"')).toBe('42');

    expect(formatFilterValue('scheduled')).toBe('scheduled');
    expect(formatFilterValue(true)).toBe('true');
    expect(formatFilterValue(null)).toBe('null');
    expect(formatFilterValue(42)).toBe('42');
    // A string that would otherwise re-parse as another type is quoted so it survives the trip.
    expect(formatFilterValue('42')).toBe('"42"');
    expect(parseFilterValue(formatFilterValue('42'))).toBe('42');
    expect(parseFilterValue(formatFilterValue('true'))).toBe('true');
  });
});

describe('hooks-panel-vm / form state', () => {
  it('hydrates the form from a script-based declaration', () => {
    const form = formStateFromDetail(hook({
      id: 'edit-guard',
      event: 'agent:pre-tool',
      matcher: 'Edit|Write',
      run: { script: 'edit-guard.mjs', command: null, timeoutSec: 10 },
      scope: { backends: ['claude'], requiresTool: 'Edit' },
      enabled: false,
    }));
    expect(form).toEqual({
      id: 'edit-guard',
      event: 'agent:pre-tool',
      matcher: 'Edit|Write',
      filters: [],
      runKind: 'script',
      script: 'edit-guard.mjs',
      command: '',
      timeoutSec: '10',
      backends: ['claude'],
      requiresTool: 'Edit',
      result: 'none',
      enabled: false,
    });
  });

  it('hydrates the form from a command-based, filter-matched declaration', () => {
    const form = formStateFromDetail(hook({
      id: 'message-end-check',
      event: 'cortex:session.messageEnd',
      matcher: null,
      matcherFilters: { source: 'scheduled', retry: 2 },
      run: { script: null, command: 'printf ok', timeoutSec: null },
      result: 'stdout-as-prompt',
    }));
    expect(form.runKind).toBe('command');
    expect(form.command).toBe('printf ok');
    expect(form.script).toBe('');
    expect(form.timeoutSec).toBe('');
    expect(form.matcher).toBe('');
    expect(form.filters).toEqual([
      { key: 'source', value: 'scheduled' },
      { key: 'retry', value: '2' },
    ]);
    expect(form.result).toBe('stdout-as-prompt');
  });

  it('is not dirty until a field actually changes', () => {
    const detail = hook({ source: 'user', editable: true, version: null });
    const form = formStateFromDetail(detail);
    expect(isHookFormDirty(form, detail)).toBe(false);
    expect(isHookFormDirty({ ...form, matcher: 'Edit' }, detail)).toBe(true);
    expect(isHookFormDirty({ ...form, enabled: !form.enabled }, detail)).toBe(true);
    expect(isHookFormDirty({ ...form, backends: ['pi'] }, detail)).toBe(true);
    expect(isHookFormDirty({ ...form, filters: [{ key: 'a', value: 'b' }] }, detail)).toBe(true);
  });
});

describe('hooks-panel-vm / validation', () => {
  const base = { ...emptyHookForm(), id: 'my-hook', script: 'my-hook.mjs' };

  it('accepts a minimal valid user draft', () => {
    expect(validateHookForm(base, { mode: 'create', existingIds: [] })).toEqual({});
  });

  it('requires an id on create and rejects a duplicate', () => {
    expect(validateHookForm({ ...base, id: '  ' }, { mode: 'create', existingIds: [] }).id).toBeTruthy();
    expect(validateHookForm(base, { mode: 'create', existingIds: ['my-hook'] }).id).toBeTruthy();
    // The id is fixed on update, so colliding with itself is not an error.
    expect(validateHookForm(base, { mode: 'update', existingIds: ['my-hook'] }).id).toBeUndefined();
  });

  it('requires an event', () => {
    expect(validateHookForm({ ...base, event: '' }, { mode: 'create' }).event).toBeTruthy();
  });

  it('requires exactly one of script / command to be filled for the chosen run kind', () => {
    expect(validateHookForm({ ...base, script: '' }, { mode: 'create' }).run).toBeTruthy();
    expect(validateHookForm({ ...base, runKind: 'command', script: '', command: '' }, { mode: 'create' }).run)
      .toBeTruthy();
    expect(validateHookForm({ ...base, runKind: 'command', script: '', command: 'printf ok' }, { mode: 'create' }).run)
      .toBeUndefined();
  });

  it('rejects a matcher regex that will not compile', () => {
    expect(validateHookForm({ ...base, matcher: 'Edit(' }, { mode: 'create' }).matcher).toBeTruthy();
    expect(validateHookForm({ ...base, matcher: 'Edit|Write' }, { mode: 'create' }).matcher).toBeUndefined();
    // A cortex:* event uses filters, so a stale regex string is not validated.
    expect(validateHookForm(
      { ...base, event: 'cortex:session.messageEnd', matcher: 'Edit(' },
      { mode: 'create' },
    ).matcher).toBeUndefined();
  });

  it('rejects empty and duplicated filter keys', () => {
    const cortex = { ...base, event: 'cortex:session.messageEnd' };
    expect(validateHookForm(
      { ...cortex, filters: [{ key: '', value: 'x' }] },
      { mode: 'create' },
    ).filters).toBeTruthy();
    expect(validateHookForm(
      { ...cortex, filters: [{ key: 'a', value: '1' }, { key: 'a', value: '2' }] },
      { mode: 'create' },
    ).filters).toBeTruthy();
    expect(validateHookForm(
      { ...cortex, filters: [{ key: 'a', value: '1' }, { key: 'b', value: '2' }] },
      { mode: 'create' },
    ).filters).toBeUndefined();
  });

  it('rejects a non-positive or non-numeric timeout, and allows an empty one', () => {
    expect(validateHookForm({ ...base, timeoutSec: '0' }, { mode: 'create' }).timeoutSec).toBeTruthy();
    expect(validateHookForm({ ...base, timeoutSec: '-1' }, { mode: 'create' }).timeoutSec).toBeTruthy();
    expect(validateHookForm({ ...base, timeoutSec: 'ten' }, { mode: 'create' }).timeoutSec).toBeTruthy();
    expect(validateHookForm({ ...base, timeoutSec: '' }, { mode: 'create' }).timeoutSec).toBeUndefined();
    expect(validateHookForm({ ...base, timeoutSec: '10' }, { mode: 'create' }).timeoutSec).toBeUndefined();
  });

  it('rejects a result the event cannot carry', () => {
    expect(validateHookForm({ ...base, result: 'stdout-as-prompt' }, { mode: 'create' }).result).toBeTruthy();
    expect(validateHookForm(
      { ...base, event: 'cortex:session.messageEnd', result: 'stdout-as-prompt' },
      { mode: 'create' },
    ).result).toBeUndefined();
  });
});

describe('hooks-panel-vm / mutation args', () => {
  it('builds a create payload with exactly one run field', () => {
    expect(buildHookCreateArgs({
      ...emptyHookForm(),
      id: '  my-hook ',
      event: ' agent:pre-tool ',
      matcher: ' Edit|Write ',
      script: ' my-hook.mjs ',
      timeoutSec: '10',
    })).toEqual({
      id: 'my-hook',
      event: 'agent:pre-tool',
      matcher: 'Edit|Write',
      script: 'my-hook.mjs',
      timeoutSec: 10,
      enabled: true,
    });
  });

  it('sends command instead of script when the run kind is command', () => {
    const args = buildHookCreateArgs({
      ...emptyHookForm(), id: 'c', runKind: 'command', command: 'printf ok', script: 'stale.mjs',
    });
    expect(args.command).toBe('printf ok');
    expect(args.script).toBeUndefined();
  });

  it('always carries enabled, because an omitted enabled defaults to true on the server', () => {
    expect(buildHookUpdateArgs({ ...emptyHookForm(), id: 'x', script: 'x.mjs', enabled: false }).enabled)
      .toBe(false);
  });

  it('omits every empty optional field — the draft is the complete desired state', () => {
    expect(buildHookUpdateArgs({ ...emptyHookForm(), id: 'x', script: 'x.mjs' })).toEqual({
      id: 'x', event: 'agent:pre-tool', script: 'x.mjs', enabled: true,
    });
  });

  it('sends matcherFilters (never matcher) for a cortex:* event, with typed values', () => {
    const args = buildHookUpdateArgs({
      ...emptyHookForm(),
      id: 'x',
      event: 'cortex:session.messageEnd',
      script: 'x.mjs',
      matcher: 'Edit|Write',
      filters: [{ key: ' source ', value: 'scheduled' }, { key: 'retry', value: '2' }],
      result: 'stdout-as-prompt',
    });
    expect(args.matcher).toBeUndefined();
    expect(args.matcherFilters).toEqual({ source: 'scheduled', retry: 2 });
    expect(args.result).toBe('stdout-as-prompt');
  });

  it('sends matcher (never matcherFilters) for a non-cortex event', () => {
    const args = buildHookUpdateArgs({
      ...emptyHookForm(),
      id: 'x',
      script: 'x.mjs',
      matcher: 'Edit|Write',
      filters: [{ key: 'source', value: 'scheduled' }],
    });
    expect(args.matcher).toBe('Edit|Write');
    expect(args.matcherFilters).toBeUndefined();
  });

  it('omits result when it is none, since an omitted result already means fire-and-forget', () => {
    expect(buildHookUpdateArgs({ ...emptyHookForm(), id: 'x', script: 'x.mjs', result: 'none' }).result)
      .toBeUndefined();
  });

  it('carries scope only when the user actually scoped it', () => {
    const scoped = buildHookUpdateArgs({
      ...emptyHookForm(), id: 'x', script: 'x.mjs', backends: ['pi'], requiresTool: ' Edit ',
    });
    expect(scoped.backends).toEqual(['pi']);
    expect(scoped.requiresTool).toBe('Edit');
    const unscoped = buildHookUpdateArgs({ ...emptyHookForm(), id: 'x', script: 'x.mjs' });
    expect(unscoped.backends).toBeUndefined();
    expect(unscoped.requiresTool).toBeUndefined();
  });

  it('never emits a version field — a UI-built entry must stay a user entry', () => {
    const args = buildHookCreateArgs({ ...emptyHookForm(), id: 'x', script: 'x.mjs' });
    expect('version' in args).toBe(false);
    expect('blocking' in args).toBe(false);
  });
});

describe('hooks-panel-vm / event options and sample payloads', () => {
  it('merges events already present in the registry, without duplicates', () => {
    const options = hookEventOptions([
      hook({ event: 'pi:before_provider_headers' }),
      hook({ event: 'agent:pre-tool' }),
    ]);
    expect(options).toContain('pi:before_provider_headers');
    expect(options.filter((e) => e === 'agent:pre-tool')).toHaveLength(1);
  });

  it('offers no thread, task or dispatch lifecycle events', () => {
    expect(hookEventOptions([]).filter((e) => /^cortex:(thread|task|dispatch)\./.test(e))).toEqual([]);
  });
});
