import * as path from 'path';
import { getSettings } from '@core/settings.js';
import { filterHookEntries, loadHookRegistry, type HookEntry, type HookRun } from '../../store/hook-registry.js';
import { DEFAULT_TOOLS, HOOKS_DIR } from './defaults.js';

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

function nodeHook(script: string, timeout?: number): ClaudeCommandHook {
  const hook: ClaudeCommandHook = { type: 'command', command: `node ${path.join(HOOKS_DIR, script)}` };
  if (timeout != null) hook.timeout = timeout;
  return hook;
}

/** No interaction entries here: headless `-p` drops AskUserQuestion / EnterPlanMode / ExitPlanMode
 *  from the tool surface whatever `--tools` says, so a PreToolUse matcher on them could never fire.
 *  Human-in-the-loop plan approval and questions run through the interaction-bridge MCP tools
 *  (cortex_plan_exit / cortex_ask_user), which post to the same webhook endpoints. */
export function buildPreToolUseHooks() {
  const hooks: ClaudeMatcherGroup[] = [
    { matcher: 'Edit|Write', hooks: [
      nodeHook('tasks-yaml-guard.mjs', 10),
    ]},
  ];
  return hooks;
}

export const POST_TOOL_USE_HOOKS = [
  { matcher: 'Read|Grep', hooks: [
    nodeHook('memory-ref-tracker.mjs'),
    nodeHook('rules-loader.mjs'),
  ]},
  { matcher: 'Read|Edit|Write|Skill', hooks: [nodeHook('session-activity-tracker.mjs')] },
  { matcher: 'Read|Edit', hooks: [nodeHook('cortex-md-injector.mjs')] },
];

export const SESSION_START_HOOKS = [
  { matcher: 'startup|resume|clear|compact', hooks: [nodeHook('cortex-md-injector.mjs')] },
];

function buildLegacyHooksSettings(): ClaudeHooksSettings {
  return {
    PreToolUse: buildPreToolUseHooks(),
    PostToolUse: POST_TOOL_USE_HOOKS,
    SessionStart: SESSION_START_HOOKS,
  };
}

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
    ? `node ${path.join(HOOKS_DIR, run.script)}`
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
  if (getSettings().hooksLegacy) return buildLegacyHooksSettings();
  return compileRegistryHooks(toolsList);
}
