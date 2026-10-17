import { fmt, type Vocab } from '@/i18n';
import type { ToolCall } from '@/features/session/composer/chat-content';

// A tool run in words: "Ran 6 commands · Edited parser.ts" instead of one chip per call. Calls are
// counted by what they did, in the order each kind first appears; a read or an edit that touched one
// file names it, and a tool with no category of its own is named as it is.

export type ToolCategory = 'command' | 'read' | 'edit' | 'search' | 'web' | 'todo' | 'other';

const CATEGORIES: Record<Exclude<ToolCategory, 'other'>, readonly string[]> = {
  command: ['bash', 'shell', 'exec', 'run_command', 'bashoutput', 'killshell', 'killbash', 'terminal'],
  read: ['read', 'view', 'cat', 'notebookread', 'read_file'],
  edit: ['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'str_replace_editor', 'write_file', 'edit_file', 'create_file'],
  search: ['grep', 'glob', 'find', 'ls', 'search', 'list', 'list_dir', 'codebase_search'],
  web: ['webfetch', 'websearch', 'web_fetch', 'web_search', 'fetch'],
  todo: ['todowrite', 'todo_write', 'update_todos'],
};

/** The tool's own name: no server prefix, no `remote_` prefix, no `:device` qualifier. */
export function bareToolName(kind: string): string {
  const name = kind.split(':')[0].split('__').at(-1)?.split('.').at(-1) ?? kind;
  return name.replace(/^remote_/, '');
}

export function toolCategory(kind: string): ToolCategory {
  const bare = bareToolName(kind).toLowerCase();
  for (const [category, names] of Object.entries(CATEGORIES)) {
    if (names.includes(bare)) return category as ToolCategory;
  }
  return 'other';
}

export interface ToolRunPart {
  category: ToolCategory | 'thought';
  count: number;
  /** read / edit: the one file every call touched; other: the tool's name. */
  name?: string;
}

/** The file a path-shaped input names; null for anything else, and for a path cut short. */
function fileName(input: string): string | null {
  const path = input.replace(/^[\w.-]+:(?=[/~])/, '').trim();
  if (!path || path.endsWith('…') || /\s/.test(path)) return null;
  const base = path.split(/[\\/]/).at(-1) ?? '';
  return /.\.[A-Za-z0-9]+$/.test(base) ? base : null;
}

export function toolRunParts(calls: ToolCall[]): ToolRunPart[] {
  const parts: ToolRunPart[] = [];
  const files = new Map<ToolRunPart, Set<string | null>>();
  for (const call of calls) {
    if (call.thinking) {
      const thought = parts.find((p) => p.category === 'thought');
      if (thought) thought.count += 1;
      else parts.push({ category: 'thought', count: 1 });
      continue;
    }
    const category = toolCategory(call.kind);
    const name = category === 'other' ? bareToolName(call.kind) : undefined;
    let part = parts.find((p) => p.category === category && p.name === name);
    if (!part) {
      part = { category, count: 0, ...(name ? { name } : {}) };
      parts.push(part);
    }
    part.count += 1;
    if (category === 'read' || category === 'edit') {
      const seen = files.get(part) ?? new Set<string | null>();
      seen.add(fileName(call.input));
      files.set(part, seen);
    }
  }
  for (const [part, seen] of files) {
    const [only] = [...seen];
    if (seen.size === 1 && only) part.name = only;
  }
  return parts;
}

function partText(part: ToolRunPart, L: Vocab): string {
  const n = part.count;
  switch (part.category) {
    case 'command': return fmt(n === 1 ? L.chatToolCommandOne : L.chatToolCommandMany, { n });
    case 'read':
      if (part.name) return fmt(L.chatToolReadFile, { name: part.name });
      return n === 1 ? L.chatToolReadOne : fmt(L.chatToolReadMany, { n });
    case 'edit':
      if (part.name) return fmt(L.chatToolEditFile, { name: part.name });
      return n === 1 ? L.chatToolEditOne : fmt(L.chatToolEditMany, { n });
    case 'search': return fmt(n === 1 ? L.chatToolSearchOne : L.chatToolSearchMany, { n });
    case 'web': return fmt(n === 1 ? L.chatToolWebOne : L.chatToolWebMany, { n });
    case 'todo': return L.chatToolTodo;
    case 'thought': return n === 1 ? L.chatThinking : fmt(L.chatToolThoughtMany, { n });
    case 'other': return fmt(n === 1 ? L.chatToolOtherOne : L.chatToolOtherMany, { name: part.name ?? '', n });
  }
}

/** One line for a tool run: "Ran 6 commands · Edited parser.ts · Called send_decision". */
export function toolRunText(calls: ToolCall[], L: Vocab): string {
  return toolRunParts(calls).map((part) => partText(part, L)).join(' · ');
}

/** The category that leads a run (its first call's), which picks the run's icon. */
export function leadingCategory(calls: ToolCall[]): ToolCategory | 'thought' {
  return toolRunParts(calls)[0]?.category ?? 'other';
}
