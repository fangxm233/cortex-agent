// input:  hooks-panel-vm exports and HookDetail fixtures
// output: filtering, capability, validation and mutation-arg regressions
// pos:    Unit tests for the hooks settings view model
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import type { HookDetail } from '@cortex-agent/ui-contract';
import {
  HOOK_FILTER_KEYS,
  HOOK_NAMESPACE_ORDER,
  KNOWN_HOOK_EVENTS,
  buildHookCreateArgs,
  buildHookUpdateArgs,
  claudeAlternativeEvent,
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
  samplePayloadForEvent,
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
    source: 'managed',
    version: '2026.7.29',
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
    hook({ id: 'cx-end', event: 'cortex:thread.end', order: 4, mountsOn: ['server'] }),
    hook({
      id: 'template:review:end',
      event: 'cortex:thread.end',
      order: 5,
      mountsOn: ['server'],
      source: 'template-scoped',
      version: null,
      fileName: null,
      template: 'review',
      phase: 'end',
    }),
  ];

  it('exposes the six filter chips in prototype order', () => {
    expect(HOOK_FILTER_KEYS).toEqual(['all', 'agent', 'claude', 'pi', 'server', 'template']);
  });

  it('all returns every hook, untouched in load order', () => {
    expect(filterHooks(hooks, 'all', '').map((h) => h.id)).toEqual([
      'a-pre', 'a-turn', 'cc-perm', 'pi-hdr', 'cx-end', 'template:review:end',
    ]);
  });

  it('agent filters on the declaration namespace, not the mount target', () => {
    expect(filterHooks(hooks, 'agent', '').map((h) => h.id)).toEqual(['a-pre', 'a-turn']);
  });

  it('claude / pi / server filter on the real mount targets', () => {
    expect(filterHooks(hooks, 'claude', '').map((h) => h.id)).toEqual(['a-pre', 'cc-perm']);
    expect(filterHooks(hooks, 'pi', '').map((h) => h.id)).toEqual(['a-pre', 'a-turn', 'pi-hdr']);
    expect(filterHooks(hooks, 'server', '').map((h) => h.id)).toEqual(['cx-end', 'template:review:end']);
  });

  it('template filters on source, not on the event', () => {
    expect(filterHooks(hooks, 'template', '').map((h) => h.id)).toEqual(['template:review:end']);
  });

  it('search matches id, event, filename, script and command, case-insensitively', () => {
    expect(filterHooks(hooks, 'all', 'THREAD.END').map((h) => h.id)).toEqual(['cx-end', 'template:review:end']);
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
      all: 6, agent: 2, claude: 2, pi: 3, server: 2, template: 1,
    });
    expect(countHooksByFilter(hooks, 'thread.end')).toEqual({
      all: 2, agent: 0, claude: 0, pi: 0, server: 2, template: 1,
    });
  });

  it('namespaces a hook by event prefix, with template-scoped taking precedence', () => {
    expect(hookNamespace(hooks[0])).toBe('agent');
    expect(hookNamespace(hooks[2])).toBe('cc');
    expect(hookNamespace(hooks[3])).toBe('pi');
    expect(hookNamespace(hooks[4])).toBe('cortex');
    expect(hookNamespace(hooks[5])).toBe('template');
  });

  it('groups by namespace in a fixed order, dropping empty groups, ordered by load order', () => {
    expect(HOOK_NAMESPACE_ORDER).toEqual(['agent', 'cc', 'pi', 'cortex', 'template']);
    const groups = groupHooks(hooks);
    expect(groups.map((g) => g.key)).toEqual(['agent', 'cc', 'pi', 'cortex', 'template']);
    expect(groups[0].hooks.map((h) => h.id)).toEqual(['a-pre', 'a-turn']);
    expect(groupHooks(filterHooks(hooks, 'claude', '')).map((g) => g.key)).toEqual(['agent', 'cc']);
    expect(groupHooks([])).toEqual([]);
  });

  it('sorts each group by load order even when the input is shuffled', () => {
    const shuffled = [hooks[1], hooks[0]];
    expect(groupHooks(shuffled)[0].hooks.map((h) => h.id)).toEqual(['a-pre', 'a-turn']);
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
  it('managed can only be toggled, and says so', () => {
    expect(hookCapability(hook({ source: 'managed', editable: false }))).toEqual({
      canToggle: true, canEdit: false, canDelete: false, canTest: true, note: 'managed',
    });
  });

  it('user is fully editable with no note', () => {
    expect(hookCapability(hook({ source: 'user', editable: true, version: null }))).toEqual({
      canToggle: true, canEdit: true, canDelete: true, canTest: true, note: null,
    });
  });

  it('template-scoped is read-only, with no toggle at all', () => {
    expect(hookCapability(hook({ source: 'template-scoped', editable: false, version: null }))).toEqual({
      canToggle: false, canEdit: false, canDelete: false, canTest: true, note: 'template-scoped',
    });
  });

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
    expect(hasClaudeMountGap(hook({ event: 'cortex:thread.end', mountsOn: ['server'] }))).toBe(false);
    expect(hasClaudeMountGap(hook({ event: 'cc:Stop', mountsOn: ['claude'] }))).toBe(false);
  });

  it('names the cc: event that reaches the missing Claude mount point', () => {
    expect(claudeAlternativeEvent('agent:session-end')).toBe('cc:SessionEnd');
    expect(claudeAlternativeEvent('agent:pre-compact')).toBe('cc:PreCompact');
    expect(claudeAlternativeEvent('agent:user-prompt')).toBe('cc:UserPromptSubmit');
    expect(claudeAlternativeEvent('agent:turn-end')).toBe('cc:Stop');
    expect(claudeAlternativeEvent('agent:pre-tool')).toBeNull();
  });
});

describe('hooks-panel-vm / result legality', () => {
  it('mirrors the registry capability table', () => {
    expect(legalResultsForEvent('cortex:thread.start')).toEqual(['none', 'hook-result']);
    expect(legalResultsForEvent('cortex:thread.transition')).toEqual(['none', 'hook-result']);
    expect(legalResultsForEvent('cortex:thread.end')).toEqual(['none', 'hook-result']);
    expect(legalResultsForEvent('cortex:session.new')).toEqual(['none', 'stdout-as-prompt']);
    expect(legalResultsForEvent('cortex:session.messageEnd')).toEqual(['none', 'stdout-as-prompt']);
  });

  it('locks every other event down to none', () => {
    expect(legalResultsForEvent('agent:pre-tool')).toEqual(['none']);
    expect(legalResultsForEvent('cortex:task.completed')).toEqual(['none']);
    expect(isResultLocked('agent:pre-tool')).toBe(true);
    expect(isResultLocked('cortex:thread.end')).toBe(false);
  });

  it('resets an illegal result when the event changes, and keeps a legal one', () => {
    expect(reconcileResultForEvent('hook-result', 'agent:pre-tool')).toBe('none');
    expect(reconcileResultForEvent('hook-result', 'cortex:thread.end')).toBe('hook-result');
    expect(reconcileResultForEvent('stdout-as-prompt', 'cortex:thread.end')).toBe('none');
    expect(reconcileResultForEvent('none', 'cortex:thread.end')).toBe('none');
  });
});

describe('hooks-panel-vm / matcher', () => {
  it('picks the filter editor for cortex:* and the regex input everywhere else', () => {
    expect(matcherKindForEvent('cortex:thread.end')).toBe('filters');
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
    expect(parseFilterValue('task-dispatch')).toBe('task-dispatch');
    expect(parseFilterValue('true')).toBe(true);
    expect(parseFilterValue('false')).toBe(false);
    expect(parseFilterValue('null')).toBeNull();
    expect(parseFilterValue('42')).toBe(42);
    expect(parseFilterValue('"42"')).toBe('42');

    expect(formatFilterValue('task-dispatch')).toBe('task-dispatch');
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
      id: 'tasks-yaml-guard',
      event: 'agent:pre-tool',
      matcher: 'Edit|Write',
      run: { script: 'tasks-yaml-guard.mjs', command: null, timeoutSec: 10 },
      scope: { backends: ['claude'], requiresTool: 'Edit' },
      enabled: false,
    }));
    expect(form).toEqual({
      id: 'tasks-yaml-guard',
      event: 'agent:pre-tool',
      matcher: 'Edit|Write',
      filters: [],
      runKind: 'script',
      script: 'tasks-yaml-guard.mjs',
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
      id: 'task-status-check',
      event: 'cortex:thread.end',
      matcher: null,
      matcherFilters: { source: 'task-dispatch', retry: 2 },
      run: { script: null, command: 'printf ok', timeoutSec: null },
      result: 'hook-result',
    }));
    expect(form.runKind).toBe('command');
    expect(form.command).toBe('printf ok');
    expect(form.script).toBe('');
    expect(form.timeoutSec).toBe('');
    expect(form.matcher).toBe('');
    expect(form.filters).toEqual([
      { key: 'source', value: 'task-dispatch' },
      { key: 'retry', value: '2' },
    ]);
    expect(form.result).toBe('hook-result');
  });

  it('starts a new draft on a script-based agent:pre-tool hook that is enabled', () => {
    const draft = emptyHookForm();
    expect(draft.id).toBe('');
    expect(draft.event).toBe('agent:pre-tool');
    expect(draft.runKind).toBe('script');
    expect(draft.result).toBe('none');
    expect(draft.enabled).toBe(true);
    expect(draft.backends).toEqual([]);
    expect(draft.filters).toEqual([]);
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
      { ...base, event: 'cortex:thread.end', matcher: 'Edit(' },
      { mode: 'create' },
    ).matcher).toBeUndefined();
  });

  it('rejects empty and duplicated filter keys', () => {
    const cortex = { ...base, event: 'cortex:thread.end' };
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
    expect(validateHookForm({ ...base, result: 'hook-result' }, { mode: 'create' }).result).toBeTruthy();
    expect(validateHookForm(
      { ...base, event: 'cortex:thread.end', result: 'hook-result' },
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
      event: 'cortex:thread.end',
      script: 'x.mjs',
      matcher: 'Edit|Write',
      filters: [{ key: ' source ', value: 'task-dispatch' }, { key: 'retry', value: '2' }],
      result: 'hook-result',
    });
    expect(args.matcher).toBeUndefined();
    expect(args.matcherFilters).toEqual({ source: 'task-dispatch', retry: 2 });
    expect(args.result).toBe('hook-result');
  });

  it('sends matcher (never matcherFilters) for a non-cortex event', () => {
    const args = buildHookUpdateArgs({
      ...emptyHookForm(),
      id: 'x',
      script: 'x.mjs',
      matcher: 'Edit|Write',
      filters: [{ key: 'source', value: 'task-dispatch' }],
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
  it('offers every agent event plus the documented cc / pi / cortex mount points', () => {
    for (const e of [
      'agent:pre-tool', 'agent:post-tool', 'agent:session-start', 'agent:session-end',
      'agent:pre-compact', 'agent:user-prompt', 'agent:turn-end',
      'cc:PermissionRequest', 'cc:SessionEnd', 'cc:PreCompact', 'cc:UserPromptSubmit', 'cc:Stop',
      'cortex:server.start', 'cortex:thread.end', 'cortex:session.messageEnd', 'cortex:task.blocked',
    ]) {
      expect(KNOWN_HOOK_EVENTS).toContain(e);
    }
  });

  it('merges events already present in the registry, without duplicates', () => {
    const options = hookEventOptions([
      hook({ event: 'pi:before_provider_headers' }),
      hook({ event: 'agent:pre-tool' }),
    ]);
    expect(options).toContain('pi:before_provider_headers');
    expect(options.filter((e) => e === 'agent:pre-tool')).toHaveLength(1);
  });

  it('pre-fills a parseable, event-shaped sample payload', () => {
    const pre = JSON.parse(samplePayloadForEvent('agent:pre-tool')) as Record<string, unknown>;
    expect(pre.hook_event_name).toBe('PreToolUse');
    expect(pre.tool_name).toBe('Edit');

    const thread = JSON.parse(samplePayloadForEvent('cortex:thread.end')) as Record<string, unknown>;
    expect(thread.threadId).toBeDefined();
    expect(thread.source).toBe('task-dispatch');

    const session = JSON.parse(samplePayloadForEvent('cortex:session.messageEnd')) as Record<string, unknown>;
    expect(session.trigger).toBe('messageEnd');

    // Unknown events still get valid JSON rather than an empty textarea.
    const unknown = JSON.parse(samplePayloadForEvent('pi:whatever')) as Record<string, unknown>;
    expect(unknown).toBeTypeOf('object');
  });

  it('is deterministic — the same event always yields the same sample', () => {
    expect(samplePayloadForEvent('cortex:session.new')).toBe(samplePayloadForEvent('cortex:session.new'));
  });
});
