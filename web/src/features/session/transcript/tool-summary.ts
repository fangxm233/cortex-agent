import { fmt, type Vocab } from '@/i18n';
import type { ToolCall } from '@/features/session/composer/chat-content';

// A tool run as one step in words. The step is the agent's own `description` of its latest call
// ("Find usages of toolRunText"); a call without one is made readable from its kind and input —
// "Editing parser.ts" while it runs, "Edited parser.ts" once the run is over.

export type ToolCategory = 'command' | 'read' | 'edit' | 'search' | 'web' | 'todo' | 'skill' | 'other';

const CATEGORIES: Record<Exclude<ToolCategory, 'other'>, readonly string[]> = {
  command: ['bash', 'shell', 'exec', 'run_command', 'bashoutput', 'killshell', 'killbash', 'terminal'],
  read: ['read', 'view', 'cat', 'notebookread', 'read_file'],
  edit: ['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'str_replace_editor', 'write_file', 'edit_file', 'create_file'],
  search: ['grep', 'glob', 'find', 'ls', 'search', 'list', 'list_dir', 'codebase_search'],
  web: ['webfetch', 'websearch', 'web_fetch', 'web_search', 'fetch'],
  todo: ['todowrite', 'todo_write', 'update_todos'],
  skill: ['skill'],
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

/** The file a path-shaped input names; null for anything else, and for a path cut short. */
function fileName(input: string): string | null {
  const path = input.replace(/^[\w.-]+:(?=[/~])/, '').trim();
  if (!path || path.endsWith('…') || /\s/.test(path)) return null;
  const base = path.split(/[\\/]/).at(-1) ?? '';
  return /.\.[A-Za-z0-9]+$/.test(base) ? base : null;
}

/** A command as one line: its first line, spaces run together. */
function commandLine(input: string): string {
  return (input.trim().split(/\r?\n/)[0] ?? '').replace(/\s+/g, ' ');
}

export type StepCategory = ToolCategory | 'thought';
type StepArgs = (call: ToolCall) => Record<string, string>;
type StepVocab = { [K in keyof Vocab]: K extends `chatToolNow${string}` | `chatToolDid${string}` ? K : never }[keyof Vocab];

const noArgs: StepArgs = () => ({});
const lineArgs: StepArgs = (call) => ({ input: commandLine(call.input) });
const fileArgs: StepArgs = (call) => ({ name: fileName(call.input) ?? call.input.trim() });

/** Each kind of step in words, under way (`now`) and over (`done`). */
const STEPS: Record<StepCategory, { now: StepVocab; done: StepVocab; args: StepArgs }> = {
  thought: { now: 'chatToolNowThought', done: 'chatToolDidThought', args: noArgs },
  command: { now: 'chatToolNowCommand', done: 'chatToolDidCommand', args: lineArgs },
  read: { now: 'chatToolNowRead', done: 'chatToolDidRead', args: fileArgs },
  edit: { now: 'chatToolNowEdit', done: 'chatToolDidEdit', args: fileArgs },
  search: { now: 'chatToolNowSearch', done: 'chatToolDidSearch', args: lineArgs },
  web: { now: 'chatToolNowWeb', done: 'chatToolDidWeb', args: noArgs },
  todo: { now: 'chatToolNowTodo', done: 'chatToolDidTodo', args: noArgs },
  skill: { now: 'chatToolNowSkill', done: 'chatToolDidSkill', args: (call) => ({ name: call.input.trim() }) },
  other: { now: 'chatToolNowOther', done: 'chatToolDidOther', args: (call) => ({ name: bareToolName(call.kind) }) },
};

/** What a call or thought is. */
export function callCategory(call: ToolCall): StepCategory {
  return call.thinking ? 'thought' : toolCategory(call.kind);
}

/** The entry a run's line speaks for: its latest entry while live, otherwise its latest tool call. */
export function runLead(calls: ToolCall[], live: boolean): ToolCall | undefined {
  if (live) return calls[calls.length - 1];
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (!calls[i].thinking) return calls[i];
  }
  return calls[calls.length - 1];
}

/** One step in words: the call's own description, else the call made readable — "Editing
 *  parser.ts" while it is under way, "Edited parser.ts" once it is over. */
export function toolStepText(call: ToolCall, live: boolean, L: Vocab): string {
  const description = call.thinking ? '' : call.description?.trim();
  if (description) return description;
  const step = STEPS[callCategory(call)];
  return fmt(L[live ? step.now : step.done], step.args(call)).trim();
}
