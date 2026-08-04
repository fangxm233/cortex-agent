// input:  backend label + native or canonical tool name
// output: canonical ↔ backend-native tool name mappings
// pos:    Bidirectional table for tool name normalization
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { Backend } from '../types.js';

export type CanonicalToolName =
  | 'bash'
  | 'read'
  | 'write'
  | 'edit'
  | 'grep'
  | 'glob'
  | 'web_fetch'
  | 'web_search'
  | 'ask_user_question'
  | 'enter_plan_mode'
  | 'exit_plan_mode'
  | 'todo_write'
  | 'skill'
  | 'agent';

// canonical → native; null entries = backend lacks the tool natively (PI shims handled via tool registration, not name map)
type NativeMap = Partial<Record<CanonicalToolName, string>>;

const CLAUDE_TOOL_MAP: NativeMap = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  ask_user_question: 'AskUserQuestion',
  enter_plan_mode: 'EnterPlanMode',
  exit_plan_mode: 'ExitPlanMode',
  todo_write: 'TodoWrite',
  skill: 'Skill',
  agent: 'Agent',
};

const PI_TOOL_MAP: NativeMap = {
  bash: 'bash',
  read: 'read',
  write: 'write',
  edit: 'edit',
  grep: 'grep',
  glob: 'glob',
  web_fetch: 'web_fetch',
  web_search: 'web_search',
  ask_user_question: 'ask_user_question',
  enter_plan_mode: 'enter_plan_mode',
  exit_plan_mode: 'exit_plan_mode',
  todo_write: 'todo_write',
  skill: 'skill',
};

const FORWARD_BY_BACKEND: Record<Backend, NativeMap> = {
  claude: CLAUDE_TOOL_MAP,
  pi: PI_TOOL_MAP,
};

// reverse maps computed once at module load
const REVERSE_BY_BACKEND: Record<Backend, Map<string, CanonicalToolName>> = {
  claude: buildReverse(CLAUDE_TOOL_MAP),
  pi: buildReverse(PI_TOOL_MAP),
};

function buildReverse(forward: NativeMap): Map<string, CanonicalToolName> {
  const m = new Map<string, CanonicalToolName>();
  for (const [canonical, native] of Object.entries(forward)) {
    if (native) m.set(native, canonical as CanonicalToolName);
  }
  return m;
}

/** PI answers to these natively without owning a `NativeMap` entry, because the extension shim —
 *  not the name map — registers them (`pi/tool-shims.ts:227`, gated by `decide('agent', 'Agent')`). */
const PI_SHIM_ONLY_TOOLS = ['agent'];

/** Every tool label a backend's own dispatch boundary answers to. Design §13.10 GS4 draws a
 *  benchmark policy guard's allow-list from exactly this namespace, so it is derived from the table
 *  the adapters already translate through rather than restated somewhere it can drift. */
export function nativeToolNames(backend: Backend): string[] {
  const mapped = Object.values(FORWARD_BY_BACKEND[backend]).filter((name): name is string => !!name);
  return backend === 'pi' ? [...mapped, ...PI_SHIM_ONLY_TOOLS] : mapped;
}

/** Translate a backend-native tool name to canonical. MCP tools (mcp__ prefix) pass through unchanged. */
export function toCanonical(backend: Backend, nativeName: string): CanonicalToolName | string | null {
  if (nativeName.startsWith('mcp__')) return nativeName;
  return REVERSE_BY_BACKEND[backend].get(nativeName) ?? null;
}

/** Translate a canonical name to the backend-native tool name. MCP tools pass through unchanged. Returns null if backend lacks the tool. */
export function fromCanonical(backend: Backend, canonical: string): string | null {
  if (canonical.startsWith('mcp__')) return canonical;
  return FORWARD_BY_BACKEND[backend][canonical as CanonicalToolName] ?? null;
}
