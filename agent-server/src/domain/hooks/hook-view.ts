// input:  hook declarations, registry backend rules, Claude event map
// output: mount targets, legal result modes, and apply time per entry
// pos:    UI-facing derived view of a hook declaration
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { claudeEventName } from '../../agent-adapter/claude/hooks-builder.js';
import {
  RESULT_CAPABILITY_BY_EVENT,
  effectiveHookBackends,
  type HookEntry,
  type HookEvent,
  type HookResultMode,
} from '../../store/hook-registry.js';

/** Where a declaration is actually installed once compiled. */
export type HookMountTarget = 'claude' | 'pi' | 'server';

/** When a change to a declaration starts having an effect. */
export type HookApplyTime = 'next-agent' | 'server-restart';

/**
 * The concrete mount points a declaration reaches. This is the field that answers "why isn't my
 * hook firing?": `agent:session-end`, `agent:pre-compact`, `agent:user-prompt` and `agent:turn-end`
 * look backend-neutral but have no Claude mount point, so they resolve to `['pi']` alone.
 */
export function hookMountTargets(entry: HookEntry): HookMountTarget[] {
  if (entry.event.startsWith('cortex:')) return ['server'];
  const backends = effectiveHookBackends(entry);
  const targets: HookMountTarget[] = [];
  if (backends.includes('claude') && claudeEventName(entry.event) !== null) targets.push('claude');
  if (backends.includes('pi')) targets.push('pi');
  return targets;
}

/**
 * The `result` modes the loader will accept for an event. Everything outside the five whitelisted
 * events is limited to `none`, so the editor can present a constrained choice rather than let the
 * user compose a declaration that validation will reject.
 */
export function legalResultModes(event: HookEvent): HookResultMode[] {
  const capability = RESULT_CAPABILITY_BY_EVENT.get(event);
  return capability ? ['none', capability] : ['none'];
}

/**
 * `cortex:*` hooks are dispatched by the HookBus, which snapshots the registry at startup, so a
 * change only lands after a restart. Everything else is re-read when the next agent spawns.
 */
export function hookAppliesAt(event: HookEvent): HookApplyTime {
  return event.startsWith('cortex:') ? 'server-restart' : 'next-agent';
}
