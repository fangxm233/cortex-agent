import type { EnvironmentDetail, EnvironmentEntry } from '@cortex-agent/ui-contract';
import type { Lang } from '@/i18n';

/** Mirrors the server's environment name pattern so a doomed name is caught before a trip. */
export const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The environment every conversation falls back to; the server refuses to delete it. */
export const DEFAULT_ENVIRONMENT = 'main';

// --- Filtering ---

export function filterEntries(entries: readonly EnvironmentEntry[], search: string): EnvironmentEntry[] {
  const needle = search.trim().toLowerCase();
  if (needle === '') return [...entries];
  return entries.filter((entry) => (
    entry.name.toLowerCase().includes(needle)
    || (entry.description ?? '').toLowerCase().includes(needle)
  ));
}

/**
 * Which row to show. Honours an explicit request when it is still visible, otherwise falls back to
 * the first visible row so the pane is never blank while entries exist.
 */
export function resolveSelection(visible: readonly EnvironmentEntry[], requested: string | null): string | null {
  if (requested !== null && visible.some((entry) => entry.name === requested)) return requested;
  return visible[0]?.name ?? null;
}

// --- Starter skeleton ---

/** A new environment opens on something that already validates, so the first save is a rename
 *  away from working rather than a wall of errors. */
export function starterBody(): Record<string, unknown> {
  return {
    name: '',
    description: '',
    profile: '__active__',
    persistSession: false,
    promptTemplate: '{{input}}',
    tools: 'Read,Write,Edit,Glob,Grep,Bash',
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
  if (!ENVIRONMENT_NAME_PATTERN.test(name)) return EDITOR_ERRORS[lang].nameInvalid;
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
  name: string;
  body: Record<string, unknown>;
  /** Omitted when creating; otherwise the hash the editor loaded, so a save made under a stale
   *  editor is rejected rather than silently clobbering the edit that landed underneath it. */
  baseHash?: string;
}

/** Returns null when the gate is closed, so a caller cannot build args for an unsaveable state. */
export function buildSaveArgs(input: {
  name: string;
  text: string;
  loaded: string;
  creating: boolean;
  baseHash: string | null;
}): SaveArgs | null {
  if (!saveGate(input).canSave) return null;
  const { body } = parseEditor(input.text);
  if (body === null) return null;
  const args: SaveArgs = { name: input.name, body };
  if (!input.creating && input.baseHash !== null) args.baseHash = input.baseHash;
  return args;
}

// --- Detail-derived affordances ---

/** The default environment cannot be deleted; say so before the user tries. */
export function canDelete(name: string): boolean {
  return name !== DEFAULT_ENVIRONMENT;
}

/** A stock environment is byte-identical to its shipped default; editing forks it permanently. */
export function forksFromDefaults(detail: EnvironmentDetail | null): boolean {
  return detail?.origin === 'stock';
}
