import type { ThreadTemplateEntry, ThreadTemplateDetail } from '@cortex-agent/ui-contract';
import type { Lang } from '@/i18n';

export type TemplateKind = ThreadTemplateEntry['kind'];
export type TemplateFilterKey = 'all' | TemplateKind;

export const TEMPLATE_FILTER_KEYS: TemplateFilterKey[] = ['all', 'template', 'agent', 'shell'];

/** Mirrors the server's NAME_PATTERN (template-writer.ts) so a doomed name is caught before a trip. */
export const TEMPLATE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface TemplateSelection {
  kind: TemplateKind;
  name: string;
}

// --- Filtering ---

export function filterEntries(
  entries: readonly ThreadTemplateEntry[],
  filter: TemplateFilterKey,
  search: string,
): ThreadTemplateEntry[] {
  const needle = search.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filter !== 'all' && entry.kind !== filter) return false;
    if (needle === '') return true;
    return (
      entry.name.toLowerCase().includes(needle) ||
      (entry.description ?? '').toLowerCase().includes(needle)
    );
  });
}

export function countByFilter(
  entries: readonly ThreadTemplateEntry[],
  search: string,
): Record<TemplateFilterKey, number> {
  const counts = { all: 0, template: 0, agent: 0, shell: 0 } as Record<TemplateFilterKey, number>;
  for (const key of TEMPLATE_FILTER_KEYS) {
    counts[key] = filterEntries(entries, key, search).length;
  }
  return counts;
}

/**
 * Which row to show. Honours an explicit request when it is still visible, otherwise falls back to
 * the first visible row so the pane is never blank while entries exist.
 */
export function resolveSelection(
  visible: readonly ThreadTemplateEntry[],
  requested: TemplateSelection | null,
): TemplateSelection | null {
  if (requested && visible.some((e) => e.kind === requested.kind && e.name === requested.name)) {
    return requested;
  }
  const first = visible[0];
  return first ? { kind: first.kind, name: first.name } : null;
}

// --- Starter skeletons ---

/**
 * A new entity opens on something that already validates, so the first save is a rename away from
 * working rather than a wall of errors. Agent and template mirror the shipped shapes.
 */
export function starterBody(kind: TemplateKind, name: string): Record<string, unknown> {
  if (kind === 'agent') {
    return {
      name,
      description: '',
      profile: '__active__',
      persistSession: false,
      promptTemplate: '{{input}}',
      tools: 'Read,Write,Edit,Glob,Grep,Bash',
    };
  }
  if (kind === 'shell') {
    return {
      params: ['worker'],
      agents: ['{worker}'],
      transitions: [],
      entryAgent: '{worker}',
      maxTotalSteps: 2,
    };
  }
  return {
    name,
    description: '',
    agents: ['__active__'],
    transitions: [],
    entryAgent: '__active__',
    maxTotalSteps: 1,
  };
}

export function formatBody(body: unknown): string {
  return `${JSON.stringify(body, null, 2)}`;
}

// --- Editor text state ---

export interface ParsedEditor {
  /** The parsed object, or null when the text is not a JSON object. */
  body: Record<string, unknown> | null;
  /** Parse failure message, or null when it parsed. */
  parseError: string | null;
}

const EDITOR_ERRORS = {
  en: {
    bodyEmpty: 'Body is empty',
    bodyNotObject: 'Body must be a JSON object',
    nameRequired: 'Name is required',
    nameInvalid: "Name must start with a letter or digit and contain only letters, digits, '-' and '_'",
  },
  zh: {
    bodyEmpty: '内容为空',
    bodyNotObject: '内容必须是 JSON 对象',
    nameRequired: '名称不能为空',
    nameInvalid: "名称须以字母或数字开头，且只能包含字母、数字、'-' 和 '_'",
  },
} as const;

export function parseEditor(text: string, lang: Lang = 'en'): ParsedEditor {
  if (text.trim() === '') return { body: null, parseError: EDITOR_ERRORS[lang].bodyEmpty };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { body: null, parseError: EDITOR_ERRORS[lang].bodyNotObject };
    }
    return { body: parsed as Record<string, unknown>, parseError: null };
  } catch (error) {
    return { body: null, parseError: error instanceof Error ? error.message : String(error) };
  }
}

/** Text differs from what was loaded. Compared as text so whitespace edits still count as dirty. */
export function isDirty(text: string, loaded: string): boolean {
  return text !== loaded;
}

export function validateName(name: string, lang: Lang = 'en'): string | null {
  if (name.trim() === '') return EDITOR_ERRORS[lang].nameRequired;
  if (!TEMPLATE_NAME_PATTERN.test(name)) return EDITOR_ERRORS[lang].nameInvalid;
  return null;
}

// --- Save gating ---

export interface SaveGate {
  canSave: boolean;
  /** Why saving is blocked, for the footer hint. Null when it is allowed. */
  reason: 'parse' | 'name' | 'clean' | null;
}

export function saveGate(input: {
  text: string;
  loaded: string;
  name: string;
  creating: boolean;
}): SaveGate {
  const nameError = input.creating ? validateName(input.name) : null;
  if (nameError !== null) return { canSave: false, reason: 'name' };
  if (parseEditor(input.text).parseError !== null) return { canSave: false, reason: 'parse' };
  if (!input.creating && !isDirty(input.text, input.loaded)) return { canSave: false, reason: 'clean' };
  return { canSave: true, reason: null };
}

export interface SaveArgs {
  kind: TemplateKind;
  name: string;
  body: Record<string, unknown>;
  /** Omitted when creating; otherwise the hash the editor loaded, so a save made under a stale
   *  editor is rejected rather than silently clobbering the edit that landed underneath it. */
  baseHash?: string;
}

/** Returns null when the gate is closed, so a caller cannot build args for an unsaveable state. */
export function buildSaveArgs(input: {
  kind: TemplateKind;
  name: string;
  text: string;
  loaded: string;
  creating: boolean;
  baseHash: string | null;
}): SaveArgs | null {
  if (!saveGate(input).canSave) return null;
  const { body } = parseEditor(input.text);
  if (body === null) return null;
  const args: SaveArgs = { kind: input.kind, name: input.name, body };
  if (!input.creating && input.baseHash !== null) args.baseHash = input.baseHash;
  return args;
}

// --- Detail-derived affordances ---

/**
 * Transitions are re-read on every step, so a live thread on this template can be rerouted or
 * stalled by a save. That is worth a confirmation, not just a note.
 */
export function needsRunningConfirm(detail: ThreadTemplateDetail | null): boolean {
  return (detail?.runningThreads ?? 0) > 0;
}

/** Deleting is refused by the server while dependents exist; say so before the user tries. */
export function deleteBlockedReason(
  detail: ThreadTemplateDetail | null,
): 'dependents' | 'running' | null {
  if (!detail) return null;
  if (detail.usedByTemplates.length > 0) return 'dependents';
  if (detail.runningThreads > 0) return 'running';
  return null;
}

/** A stock entity is byte-identical to its shipped default; editing forks it permanently. */
export function forksFromDefaults(detail: ThreadTemplateDetail | null): boolean {
  return detail?.origin === 'stock';
}
