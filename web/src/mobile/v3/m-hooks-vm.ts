// input:  hooks.list overview DTO and canonical hook namespace groups
// output: shared-namespace-grouped mobile rows and read-only declaration slots
// pos:    Mobile projection over the canonical hooks settings grouping model
// >>> If I am updated, update my header comment and CORTEX.md <<<

// Read-only mirror of the hook registry (plan §6). Every field below has a real `hooks.list` source —
// nothing is derived from copy or invented. The mobile surface renders the declaration exactly as the
// server reports it; editing lives on desktop, so there is no draft/patch shape here.
import type { HookDetail, HooksOverview } from '@cortex-agent/ui-contract';
import { groupHooks, type HookNamespace } from '@/features/settings/hooks-panel-vm';

/** Mobile copy and presentation cover every canonical namespace, including its future-event fallback. */
export type MHookGroupKey = HookNamespace;

/** The matcher as the loader accepts it: a regex string, or equality filters for `cortex:*` events. */
export type MHookMatcher =
  | { kind: 'regex'; value: string }
  | { kind: 'filters'; entries: { key: string; value: string }[] };

/** Exactly one of script/command is declared (the loader enforces it); `none` covers a template hook
 *  that reports neither, so the sheet shows a gap instead of an empty string. */
export type MHookRun =
  | { kind: 'script'; value: string; missing: boolean }
  | { kind: 'command'; value: string; missing: false }
  | { kind: 'none' };

/** The complete declaration, flattened one field per sheet row. */
export interface MHookDetailVm {
  id: string;
  event: string;
  matcher: MHookMatcher | null;
  run: MHookRun;
  /** Registry timeout in SECONDS; null for template hooks (they declare milliseconds) and no-timeout entries. */
  timeoutSec: number | null;
  /** `scope.backends`; null when the hook declares no scope at all. */
  backends: string[] | null;
  requiresTool: string | null;
  result: string | null;
  blocking: { mode: string; ttlMin: number } | null;
  source: HookDetail['source'];
  /** CalVer stamp — present only on managed entries (it is what makes them managed). */
  version: string | null;
  fileName: string | null;
  /** Position in load order, which is also execution order within one event. */
  order: number;
  mountsOn: HookDetail['mountsOn'];
  appliesAt: HookDetail['appliesAt'];
  /** Owning thread template / phase — template-scoped hooks only. */
  template: string | null;
  phase: string | null;
}

export interface MHookRow {
  /** Stable list key. `order` is a global load index, so it disambiguates repeated ids. */
  key: string;
  id: string;
  event: string;
  source: HookDetail['source'];
  enabled: boolean;
  mountsOn: HookDetail['mountsOn'];
  /** A declared `run.script` that does not resolve on disk — the hook fails silently at runtime. */
  scriptMissing: boolean;
  detail: MHookDetailVm;
}

export interface MHookGroup {
  key: MHookGroupKey;
  rows: MHookRow[];
}

export interface MHooksVm {
  groups: MHookGroup[];
  total: number;
  enabledCount: number;
  missingScriptCount: number;
}

function toMatcher(hook: HookDetail): MHookMatcher | null {
  if (hook.matcher !== null) return { kind: 'regex', value: hook.matcher };
  if (hook.matcherFilters === null) return null;
  return {
    kind: 'filters',
    entries: Object.entries(hook.matcherFilters).map(([key, value]) => ({
      key,
      // `null` is a legal filter value (matches an absent field) and must stay distinguishable
      // from the empty string, so it is printed rather than blanked.
      value: value === null ? 'null' : String(value),
    })),
  };
}

function toRun(hook: HookDetail): MHookRun {
  if (hook.run.script !== null) {
    return { kind: 'script', value: hook.run.script, missing: hook.scriptExists === false };
  }
  if (hook.run.command !== null) return { kind: 'command', value: hook.run.command, missing: false };
  return { kind: 'none' };
}

function toDetail(hook: HookDetail): MHookDetailVm {
  return {
    id: hook.id,
    event: hook.event,
    matcher: toMatcher(hook),
    run: toRun(hook),
    timeoutSec: hook.run.timeoutSec,
    backends: hook.scope?.backends ?? null,
    requiresTool: hook.scope?.requiresTool ?? null,
    result: hook.result,
    blocking: hook.blocking,
    source: hook.source,
    version: hook.version,
    fileName: hook.fileName,
    order: hook.order,
    mountsOn: hook.mountsOn,
    appliesAt: hook.appliesAt,
    template: hook.template,
    phase: hook.phase,
  };
}

function toRow(hook: HookDetail): MHookRow {
  return {
    key: `${hook.id}#${hook.order}`,
    id: hook.id,
    event: hook.event,
    source: hook.source,
    enabled: hook.enabled,
    mountsOn: hook.mountsOn,
    scriptMissing: hook.scriptExists === false,
    detail: toDetail(hook),
  };
}

/** Map the real `hooks.list` overview into the mobile hooks screen view-model. */
export function buildMHooksVm(overview: HooksOverview): MHooksVm {
  const groups = groupHooks(overview.hooks).map((group) => ({
    key: group.key,
    rows: group.hooks.map(toRow),
  }));

  return {
    groups,
    total: overview.hooks.length,
    enabledCount: overview.hooks.filter((h) => h.enabled).length,
    missingScriptCount: overview.hooks.filter((h) => h.scriptExists === false).length,
  };
}
