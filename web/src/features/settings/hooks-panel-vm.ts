// input:  HookDetail records, chip/search state, and editor form fields
// output: filtered groups, capability flags, validation and hooks.* mutation args
// pos:    Pure view model for the desktop hooks settings panel
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type {
  HookDetail,
  HookDraftInput,
  HooksCreateArgs,
  HooksUpdateArgs,
} from '@cortex-agent/ui-contract';

// The registry's leaf types are not re-exported by the contract, so they are recovered from
// HookDetail — which keeps them pinned to the server shape rather than restated by hand.
export type HookResultMode = NonNullable<HookDetail['result']>;
export type HookBackend = NonNullable<NonNullable<HookDetail['scope']>['backends']>[number];
export type HookFilterValue = NonNullable<HookDetail['matcherFilters']>[string];
export type HookMountTarget = HookDetail['mountsOn'][number];

// ── filtering ─────────────────────────────────────────────────────────────────────────────────

/**
 * The chips above the list. `agent` selects on the DECLARATION namespace (the backend-neutral
 * `agent:*` events); `claude` / `pi` / `server` select on the real MOUNT targets, so an
 * `agent:pre-tool` entry answers both `agent` and `claude`. That asymmetry is the point: the
 * declaration says what you wrote, the mount says where it actually runs.
 */
export type HookFilterKey = 'all' | 'agent' | 'claude' | 'pi' | 'server' | 'template';

export const HOOK_FILTER_KEYS: readonly HookFilterKey[] = [
  'all',
  'agent',
  'claude',
  'pi',
  'server',
  'template',
];

function matchesFilterKey(hook: HookDetail, filter: HookFilterKey): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'agent':
      return hook.event.startsWith('agent:');
    case 'claude':
      return hook.mountsOn.includes('claude');
    case 'pi':
      return hook.mountsOn.includes('pi');
    case 'server':
      return hook.mountsOn.includes('server');
    case 'template':
      return hook.source === 'template-scoped';
  }
}

function searchHaystack(hook: HookDetail): string {
  return [
    hook.id,
    hook.event,
    hook.fileName ?? '',
    hook.run.script ?? '',
    hook.run.command ?? '',
    hook.matcher ?? '',
    hook.template ?? '',
    hook.source,
  ]
    .join('\n')
    .toLowerCase();
}

/** Chip and search compose: the chip narrows the set, the query narrows it again. */
export function filterHooks(
  hooks: readonly HookDetail[],
  filter: HookFilterKey,
  search: string,
): HookDetail[] {
  const query = search.trim().toLowerCase();
  return hooks.filter(
    (hook) =>
      matchesFilterKey(hook, filter) &&
      (query === '' || searchHaystack(hook).includes(query)),
  );
}

/** Per-chip counts, each computed against the CURRENT search — so a chip never lies about its set. */
export function countHooksByFilter(
  hooks: readonly HookDetail[],
  search: string,
): Record<HookFilterKey, number> {
  const counts = {} as Record<HookFilterKey, number>;
  for (const key of HOOK_FILTER_KEYS) counts[key] = filterHooks(hooks, key, search).length;
  return counts;
}

// ── grouping ──────────────────────────────────────────────────────────────────────────────────

export type HookNamespace = 'agent' | 'cc' | 'pi' | 'cortex' | 'template';

export const HOOK_NAMESPACE_ORDER: readonly HookNamespace[] = ['agent', 'cc', 'pi', 'cortex', 'template'];

/**
 * Template-scoped entries carry a `cortex:thread.*` event but are owned by a template file, so they
 * get their own group rather than being mixed into the registry's `cortex:` block.
 */
export function hookNamespace(hook: HookDetail): HookNamespace {
  if (hook.source === 'template-scoped') return 'template';
  if (hook.event.startsWith('agent:')) return 'agent';
  if (hook.event.startsWith('cc:')) return 'cc';
  if (hook.event.startsWith('pi:')) return 'pi';
  return 'cortex';
}

export interface HookGroup {
  key: HookNamespace;
  hooks: HookDetail[];
}

/** Groups in a fixed namespace order; inside a group, load order — which IS execution order. */
export function groupHooks(hooks: readonly HookDetail[]): HookGroup[] {
  const buckets = new Map<HookNamespace, HookDetail[]>();
  for (const hook of hooks) {
    const key = hookNamespace(hook);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(hook);
    else buckets.set(key, [hook]);
  }
  const groups: HookGroup[] = [];
  for (const key of HOOK_NAMESPACE_ORDER) {
    const bucket = buckets.get(key);
    if (!bucket || bucket.length === 0) continue;
    groups.push({
      key,
      hooks: [...bucket].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    });
  }
  return groups;
}

/**
 * The selection is sticky against the FULL registry, not the filtered view: narrowing the chips or
 * typing in the search box must not silently reassign the detail pane and throw away an unsaved
 * edit. Only a selection that no longer exists at all (deleted, or never made) falls back — to the
 * first visible row, so a fresh pane opens on something the current filter actually shows.
 */
export function resolveSelectedHookId(
  hooks: readonly HookDetail[],
  visible: readonly HookDetail[],
  requested: string | null,
): string | null {
  if (requested !== null && hooks.some((hook) => hook.id === requested)) return requested;
  return visible[0]?.id ?? hooks[0]?.id ?? null;
}

// ── capability by source ──────────────────────────────────────────────────────────────────────

export interface HookCapability {
  canToggle: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canTest: boolean;
  /** Which persistent inline explanation the detail pane must show. */
  note: 'managed' | 'template-scoped' | null;
}

/**
 * managed — every non-`enabled` field is restored by the next hook sync, so offering to edit them
 * would be a lie; even the toggle is only durable until that sync.
 * template-scoped — owned by a thread-template file; the writer rejects it outright.
 * user — the only fully writable source, and `editable` is the server's own say-so.
 */
export function hookCapability(hook: HookDetail): HookCapability {
  if (hook.source === 'template-scoped') {
    return { canToggle: false, canEdit: false, canDelete: false, canTest: true, note: 'template-scoped' };
  }
  if (hook.source === 'managed') {
    return { canToggle: true, canEdit: false, canDelete: false, canTest: true, note: 'managed' };
  }
  const writable = hook.editable;
  return { canToggle: true, canEdit: writable, canDelete: writable, canTest: true, note: null };
}

// ── mount gaps ────────────────────────────────────────────────────────────────────────────────

/** The four `agent:*` events Claude has no mount point for, and the `cc:` event that reaches it. */
const CLAUDE_ALTERNATIVE_EVENT: Readonly<Record<string, string>> = {
  'agent:session-end': 'cc:SessionEnd',
  'agent:pre-compact': 'cc:PreCompact',
  'agent:user-prompt': 'cc:UserPromptSubmit',
  'agent:turn-end': 'cc:Stop',
};

/**
 * True when a backend-neutral `agent:*` declaration silently reaches PI only. This is the single
 * most common "why isn't my hook firing?" cause, so the detail pane calls it out.
 */
export function hasClaudeMountGap(hook: Pick<HookDetail, 'event' | 'mountsOn'>): boolean {
  return hook.event.startsWith('agent:') && !hook.mountsOn.includes('claude');
}

export function claudeAlternativeEvent(event: string): string | null {
  return CLAUDE_ALTERNATIVE_EVENT[event] ?? null;
}

// ── result legality ───────────────────────────────────────────────────────────────────────────

/** Mirrors RESULT_CAPABILITY_BY_EVENT in the registry — the loader rejects anything else. */
const RESULT_CAPABILITY_BY_EVENT: Readonly<Record<string, Exclude<HookResultMode, 'none'>>> = {
  'cortex:thread.start': 'hook-result',
  'cortex:thread.transition': 'hook-result',
  'cortex:thread.end': 'hook-result',
  'cortex:session.new': 'stdout-as-prompt',
  'cortex:session.messageEnd': 'stdout-as-prompt',
};

/** The result modes the editor may offer for an event — never more than two. */
export function legalResultsForEvent(event: string): HookResultMode[] {
  const capability = RESULT_CAPABILITY_BY_EVENT[event];
  return capability ? ['none', capability] : ['none'];
}

/** True when `none` is the only legal choice, so the select renders disabled with an explanation. */
export function isResultLocked(event: string): boolean {
  return legalResultsForEvent(event).length === 1;
}

/** Applied whenever the event changes, so the form can never hold a result the loader will reject. */
export function reconcileResultForEvent(result: HookResultMode, event: string): HookResultMode {
  return legalResultsForEvent(event).includes(result) ? result : 'none';
}

// ── matchers ──────────────────────────────────────────────────────────────────────────────────

export type HookMatcherKind = 'regex' | 'filters';

/** `cortex:*` matchers are equality filter objects; every other namespace matches by regex. */
export function matcherKindForEvent(event: string): HookMatcherKind {
  return event.startsWith('cortex:') ? 'filters' : 'regex';
}

/** Same judgement as the server's validateRegexMatcher: does it compile? Empty = match everything. */
export function validateMatcherRegex(source: string): string | null {
  if (source.trim() === '') return null;
  try {
    new RegExp(source);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Filter values are typed (`===` comparison on the server), so the editor round-trips them through
 * JSON: bare text stays a string, `true` / `42` / `null` become their typed form, and a string that
 * would otherwise re-parse as another type is written back quoted.
 */
export function parseFilterValue(raw: string): HookFilterValue {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      parsed === null ||
      typeof parsed === 'string' ||
      typeof parsed === 'number' ||
      typeof parsed === 'boolean'
    ) {
      return parsed;
    }
  } catch {
    // not JSON — it is a bare string, kept verbatim (interior spaces are meaningful)
  }
  return raw;
}

export function formatFilterValue(value: HookFilterValue): string {
  if (typeof value === 'string') {
    return parseFilterValue(value) === value ? value : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

export interface HookFilterRow {
  key: string;
  value: string;
}

export function buildMatcherFilters(rows: readonly HookFilterRow[]): Record<string, HookFilterValue> | null {
  const filters: Record<string, HookFilterValue> = {};
  let any = false;
  for (const row of rows) {
    const key = row.key.trim();
    if (key === '') continue;
    filters[key] = parseFilterValue(row.value);
    any = true;
  }
  return any ? filters : null;
}

// ── form state ────────────────────────────────────────────────────────────────────────────────

export type HookRunKind = 'script' | 'command';

/** One control per field: everything is a string or a small enum so the inputs bind directly. */
export interface HookFormState {
  id: string;
  event: string;
  matcher: string;
  filters: HookFilterRow[];
  runKind: HookRunKind;
  script: string;
  command: string;
  timeoutSec: string;
  /** Empty means unscoped — the registry then derives the backends from the event prefix. */
  backends: HookBackend[];
  requiresTool: string;
  result: HookResultMode;
  enabled: boolean;
}

export function formStateFromDetail(hook: HookDetail): HookFormState {
  return {
    id: hook.id,
    event: hook.event,
    matcher: hook.matcher ?? '',
    filters: hook.matcherFilters
      ? Object.entries(hook.matcherFilters).map(([key, value]) => ({ key, value: formatFilterValue(value) }))
      : [],
    runKind: hook.run.command !== null ? 'command' : 'script',
    script: hook.run.script ?? '',
    command: hook.run.command ?? '',
    timeoutSec: hook.run.timeoutSec == null ? '' : String(hook.run.timeoutSec),
    backends: hook.scope?.backends ? [...hook.scope.backends] : [],
    requiresTool: hook.scope?.requiresTool ?? '',
    result: hook.result ?? 'none',
    enabled: hook.enabled,
  };
}

export function emptyHookForm(): HookFormState {
  return {
    id: '',
    event: 'agent:pre-tool',
    matcher: '',
    filters: [],
    runKind: 'script',
    script: '',
    command: '',
    timeoutSec: '',
    backends: [],
    requiresTool: '',
    result: 'none',
    enabled: true,
  };
}

function canonicalForm(form: HookFormState): string {
  return JSON.stringify({
    id: form.id.trim(),
    event: form.event.trim(),
    matcher: form.matcher,
    filters: form.filters.map((row) => [row.key, row.value]),
    runKind: form.runKind,
    script: form.script,
    command: form.command,
    timeoutSec: form.timeoutSec,
    backends: [...form.backends].sort(),
    requiresTool: form.requiresTool,
    result: form.result,
    enabled: form.enabled,
  });
}

/** Drives the Save/Revert enablement — a pristine form must never be savable. */
export function isHookFormDirty(form: HookFormState, hook: HookDetail): boolean {
  return canonicalForm(form) !== canonicalForm(formStateFromDetail(hook));
}

// ── validation ────────────────────────────────────────────────────────────────────────────────

export type HookFieldError =
  | 'id-required'
  | 'id-taken'
  | 'event-required'
  | 'matcher-invalid'
  | 'filters-empty-key'
  | 'filters-duplicate-key'
  | 'run-required'
  | 'timeout-invalid'
  | 'result-illegal';

export interface HookFormErrors {
  id?: HookFieldError;
  event?: HookFieldError;
  matcher?: HookFieldError;
  filters?: HookFieldError;
  run?: HookFieldError;
  timeoutSec?: HookFieldError;
  result?: HookFieldError;
}

export interface HookFormValidationOptions {
  mode: 'create' | 'update';
  /** Every id already claimed by the registry — `create` must not produce a silent collision. */
  existingIds?: readonly string[];
}

export function validateHookForm(
  form: HookFormState,
  options: HookFormValidationOptions,
): HookFormErrors {
  const errors: HookFormErrors = {};

  if (options.mode === 'create') {
    const id = form.id.trim();
    if (id === '') errors.id = 'id-required';
    else if ((options.existingIds ?? []).includes(id)) errors.id = 'id-taken';
  }

  const event = form.event.trim();
  if (event === '') errors.event = 'event-required';

  if (matcherKindForEvent(event) === 'regex') {
    if (validateMatcherRegex(form.matcher) !== null) errors.matcher = 'matcher-invalid';
  } else {
    const keys = form.filters.map((row) => row.key.trim());
    if (keys.some((key) => key === '')) errors.filters = 'filters-empty-key';
    else if (new Set(keys).size !== keys.length) errors.filters = 'filters-duplicate-key';
  }

  const run = form.runKind === 'script' ? form.script.trim() : form.command.trim();
  if (run === '') errors.run = 'run-required';

  const timeout = form.timeoutSec.trim();
  if (timeout !== '') {
    const seconds = Number(timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) errors.timeoutSec = 'timeout-invalid';
  }

  if (!legalResultsForEvent(event).includes(form.result)) errors.result = 'result-illegal';

  return errors;
}

export function isHookFormValid(errors: HookFormErrors): boolean {
  return Object.keys(errors).length === 0;
}

// ── mutation args ─────────────────────────────────────────────────────────────────────────────

/**
 * The draft is the COMPLETE desired state — the writer deletes anything omitted — so every empty
 * field is left out on purpose. Two fields are never emitted: `version` (writing it would disguise
 * a user entry as managed and expose it to hook-sync) and `blocking` (the API does not accept it).
 * `enabled` is always emitted, because an omitted `enabled` defaults to TRUE on the server and
 * would silently resurrect a disabled hook on the next save.
 */
export function buildHookDraft(form: HookFormState): HookDraftInput {
  const event = form.event.trim();
  const draft: HookDraftInput = { event };

  if (matcherKindForEvent(event) === 'regex') {
    const matcher = form.matcher.trim();
    if (matcher !== '') draft.matcher = matcher;
  } else {
    const filters = buildMatcherFilters(form.filters);
    if (filters !== null) draft.matcherFilters = filters;
  }

  if (form.runKind === 'script') {
    const script = form.script.trim();
    if (script !== '') draft.script = script;
  } else {
    const command = form.command.trim();
    if (command !== '') draft.command = command;
  }

  const timeout = form.timeoutSec.trim();
  if (timeout !== '') {
    const seconds = Number(timeout);
    if (Number.isFinite(seconds) && seconds > 0) draft.timeoutSec = seconds;
  }

  if (form.backends.length > 0) draft.backends = [...form.backends];
  const requiresTool = form.requiresTool.trim();
  if (requiresTool !== '') draft.requiresTool = requiresTool;

  // `none` is the loader's default for an omitted result, so writing it adds noise, not meaning.
  if (form.result !== 'none' && legalResultsForEvent(event).includes(form.result)) {
    draft.result = form.result;
  }

  draft.enabled = form.enabled;
  return draft;
}

export function buildHookCreateArgs(form: HookFormState): HooksCreateArgs {
  return { id: form.id.trim(), ...buildHookDraft(form) };
}

export function buildHookUpdateArgs(form: HookFormState): HooksUpdateArgs {
  return { id: form.id.trim(), ...buildHookDraft(form) };
}

// ── event catalogue and test payloads ─────────────────────────────────────────────────────────

/** Every documented mount point. The event field stays free text — this list is a suggestion set. */
export const KNOWN_HOOK_EVENTS: readonly string[] = [
  'agent:pre-tool',
  'agent:post-tool',
  'agent:session-start',
  'agent:session-end',
  'agent:pre-compact',
  'agent:user-prompt',
  'agent:turn-end',
  'cc:PreToolUse',
  'cc:PostToolUse',
  'cc:SessionStart',
  'cc:SessionEnd',
  'cc:PreCompact',
  'cc:UserPromptSubmit',
  'cc:Stop',
  'cc:PermissionRequest',
  'pi:tool_call',
  'pi:tool_result',
  'pi:session_start',
  'pi:session_shutdown',
  'pi:before_provider_headers',
  'cortex:server.start',
  'cortex:server.shutdown',
  'cortex:thread.start',
  'cortex:thread.transition',
  'cortex:thread.end',
  'cortex:dispatch.started',
  'cortex:schedule.fired',
  'cortex:task.completed',
  'cortex:task.blocked',
  'cortex:client.connected',
  'cortex:client.disconnected',
  'cortex:session.new',
  'cortex:session.messageEnd',
];

/** The catalogue plus anything the deployed registry already uses, so nothing looks unsupported. */
export function hookEventOptions(hooks: readonly Pick<HookDetail, 'event'>[]): string[] {
  const known = new Set(KNOWN_HOOK_EVENTS);
  const extra = new Set(hooks.map((hook) => hook.event).filter((event) => !known.has(event)));
  return [...KNOWN_HOOK_EVENTS, ...extra];
}

const SAMPLE_SESSION_ENVELOPE = {
  channel: 'C0000000',
  sessionId: 'sess_example',
  sessionName: 'cortex-0000',
  executionId: 'exec_example',
  profile: 'default',
  timestampIso: '2026-01-01T00:00:00.000Z',
};

const SAMPLE_THREAD_CONTEXT = {
  threadId: 'thr_example',
  templateName: 'example',
  source: 'task-dispatch',
  project: 'my-project',
  projectId: 'my-project',
  taskId: '0000',
  currentStepIndex: 0,
  activeAgent: 'executor',
};

const SAMPLE_TOOL_CALL = {
  hook_event_name: 'PreToolUse',
  session_id: 'sess_example',
  cwd: '/tmp',
  tool_name: 'Edit',
  tool_input: { file_path: '/tmp/example.txt', new_string: 'example' },
};

const SAMPLE_PAYLOADS: Readonly<Record<string, unknown>> = {
  'agent:pre-tool': SAMPLE_TOOL_CALL,
  'cc:PreToolUse': SAMPLE_TOOL_CALL,
  'pi:tool_call': SAMPLE_TOOL_CALL,
  'agent:post-tool': {
    ...SAMPLE_TOOL_CALL,
    hook_event_name: 'PostToolUse',
    tool_response: { success: true },
    is_error: false,
  },
  'agent:session-start': {
    hook_event_name: 'SessionStart',
    session_id: 'sess_example',
    cwd: '/tmp',
    source: 'startup',
  },
  'agent:session-end': { hook_event_name: 'SessionEnd', session_id: 'sess_example', cwd: '/tmp' },
  'agent:pre-compact': { hook_event_name: 'PreCompact', session_id: 'sess_example', cwd: '/tmp' },
  'agent:user-prompt': {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess_example',
    cwd: '/tmp',
    prompt: 'example prompt',
  },
  'agent:turn-end': { hook_event_name: 'Stop', session_id: 'sess_example', cwd: '/tmp' },
  'cortex:server.start': { version: '0.0.0', pid: 0 },
  'cortex:server.shutdown': { version: '0.0.0', pid: 0, reason: 'SIGTERM' },
  'cortex:thread.start': { ...SAMPLE_THREAD_CONTEXT, phase: 'start' },
  'cortex:thread.transition': { ...SAMPLE_THREAD_CONTEXT, phase: 'transition' },
  'cortex:thread.end': { ...SAMPLE_THREAD_CONTEXT, phase: 'end' },
  'cortex:dispatch.started': {
    taskId: '0000',
    project: 'my-project',
    source: 'task-dispatch',
    templateName: 'example',
  },
  'cortex:schedule.fired': { scheduleId: 'sch_example', name: 'example', project: 'my-project' },
  'cortex:task.completed': { taskId: '0000', project: 'my-project' },
  'cortex:task.blocked': { taskId: '0000', project: 'my-project', reason: 'example reason' },
  'cortex:client.connected': { device: 'workstation' },
  'cortex:client.disconnected': { device: 'workstation', reason: 'socket closed' },
  'cortex:session.new': { ...SAMPLE_SESSION_ENVELOPE, trigger: 'new' },
  'cortex:session.messageEnd': { ...SAMPLE_SESSION_ENVELOPE, trigger: 'messageEnd' },
};

/**
 * A deterministic, event-shaped starting point for the Test payload editor. Writing one by hand is
 * the slowest part of debugging a hook, and an empty textarea invites a payload the script cannot
 * read. Values are neutral placeholders, never real session or project data.
 */
export function samplePayloadForEvent(event: string): string {
  const known = SAMPLE_PAYLOADS[event];
  if (known !== undefined) return JSON.stringify(known, null, 2);
  if (event.startsWith('cc:')) {
    return JSON.stringify(
      { hook_event_name: event.slice(3), session_id: 'sess_example', cwd: '/tmp' },
      null,
      2,
    );
  }
  if (event.startsWith('pi:')) {
    return JSON.stringify({ event: event.slice(3), session_id: 'sess_example' }, null, 2);
  }
  return JSON.stringify({ hook_event_name: event }, null, 2);
}

/** True when the textarea content would be rejected before it ever reaches the hook. */
export function isPayloadParseable(payload: string): boolean {
  if (payload.trim() === '') return false;
  try {
    JSON.parse(payload);
    return true;
  } catch {
    return false;
  }
}
