import { hookScriptArgs } from '../../core/hook-scripts.js';
import { filterHookEntries, loadHookRegistry, type HookEntry, type HookRun } from '../../store/hook-registry.js';
import { DEFAULT_TOOLS } from './defaults.js';

interface ClaudeCommandHook {
  type: 'command';
  command: string;
  timeout?: number;
}

interface ClaudeMatcherGroup {
  matcher?: string;
  hooks: ClaudeCommandHook[];
}

type ClaudeHooksSettings = Record<string, ClaudeMatcherGroup[]>;

const AGENT_EVENT_NAMES: Partial<Record<HookEntry['event'], string>> = {
  'agent:pre-tool': 'PreToolUse',
  'agent:post-tool': 'PostToolUse',
  'agent:session-start': 'SessionStart',
};

/**
 * The Claude settings event an entry compiles to, or null when Claude has no mount point for it.
 * Only three of the seven `agent:*` events map; the rest reach PI only and must be declared as
 * `cc:*` to hook Claude. Exported so the UI can surface that asymmetry instead of failing silently.
 */
export function claudeEventName(event: HookEntry['event']): string | null {
  if (event.startsWith('cc:')) return event.slice(3);
  return AGENT_EVENT_NAMES[event] ?? null;
}

function commandHook(run: HookRun): ClaudeCommandHook {
  const command = run.script !== undefined
    ? `node ${hookScriptArgs(run.script).join(' ')}`
    : run.command;
  const hook: ClaudeCommandHook = { type: 'command', command };
  if (run.timeout !== undefined) hook.timeout = run.timeout;
  return hook;
}

function appendEntry(settings: ClaudeHooksSettings, event: string, entry: HookEntry): void {
  const groups = settings[event] ?? [];
  if (settings[event] === undefined) settings[event] = groups;
  const matcher = typeof entry.matcher === 'string' ? entry.matcher : undefined;
  const previous = groups.at(-1);
  if (previous && previous.matcher === matcher) {
    previous.hooks.push(commandHook(entry.run));
    return;
  }
  const hooks = [commandHook(entry.run)];
  groups.push(matcher === undefined ? { hooks } : { matcher, hooks });
}

function compileRegistryHooks(toolsList: string[]): ClaudeHooksSettings {
  const entries = filterHookEntries(loadHookRegistry(), {
    backend: 'claude',
    availableTools: new Set(toolsList),
  });
  const settings: ClaudeHooksSettings = Object.create(null) as ClaudeHooksSettings;
  for (const entry of entries) {
    const event = claudeEventName(entry.event);
    if (event !== null) appendEntry(settings, event, entry);
  }
  return settings;
}

export function buildHooksSettings(tools: string | null) {
  const toolsList = (tools || DEFAULT_TOOLS).split(',').map((tool) => tool.trim());
  return compileRegistryHooks(toolsList);
}
