// input:  hooks.list overview DTO (HookDetail records)
// output: namespace-grouped hook rows and read-only declaration slots
// pos:    Pure data mapping for the mobile hooks screen
// >>> If I am updated, update my header comment and CORTEX.md <<<

// Read-only mirror of the hook registry (plan §6). Every field below has a real `hooks.list` source —
// nothing is derived from copy or invented. The mobile surface renders the declaration exactly as the
// server reports it; editing lives on desktop, so there is no draft/patch shape here.
import type { HookDetail, HooksOverview } from '@cortex-agent/ui-contract';

/** `template` is a source, not an event namespace — template-scoped hooks carry a `cortex:` event but
 *  are owned by a thread-template file, so they are listed apart (mirrors the desktop separator). */
export type MHookGroupKey = 'agent' | 'cc' | 'pi' | 'cortex' | 'template' | 'other';

/** Render order of the groups. `other` is the safety net for an event namespace this build does not
 *  know yet — an inventory that silently drops entries would be worse than an unlabelled group. */
export const HOOK_GROUP_ORDER: readonly MHookGroupKey[] = [
  'agent',
  'cc',
  'pi',
  'cortex',
  'template',
  'other',
];

const NAMESPACE_PREFIX: ReadonlyArray<{ prefix: string; key: MHookGroupKey }> = [
  { prefix: 'agent:', key: 'agent' },
  { prefix: 'cc:', key: 'cc' },
  { prefix: 'pi:', key: 'pi' },
  { prefix: 'cortex:', key: 'cortex' },
];

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

function groupKey(hook: HookDetail): MHookGroupKey {
  if (hook.source === 'template-scoped') return 'template';
  return NAMESPACE_PREFIX.find((n) => hook.event.startsWith(n.prefix))?.key ?? 'other';
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
  const buckets = new Map<MHookGroupKey, MHookRow[]>();
  for (const hook of overview.hooks) {
    const key = groupKey(hook);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(toRow(hook));
    else buckets.set(key, [toRow(hook)]);
  }

  const groups: MHookGroup[] = [];
  for (const key of HOOK_GROUP_ORDER) {
    const rows = buckets.get(key);
    // Load order is execution order within an event; the server emits it as a global index, so
    // sorting on it restores the on-disk sequence regardless of how the list arrives.
    if (rows) groups.push({ key, rows: rows.sort((a, b) => a.detail.order - b.detail.order) });
  }

  return {
    groups,
    total: overview.hooks.length,
    enabledCount: overview.hooks.filter((h) => h.enabled).length,
    missingScriptCount: overview.hooks.filter((h) => h.scriptExists === false).length,
  };
}
