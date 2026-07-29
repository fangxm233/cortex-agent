// input:  tools, declarative hook registry, Claude defaults
// output: buildHooksSettings + hardcoded rollback hook table
// pos:    Compiles registry entries into Claude hook settings
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as path from 'path';
import { filterHookEntries, loadHookRegistry, type HookEntry, type HookRun } from '../../store/hook-registry.js';
import { DEFAULT_TOOLS, HOOKS_DIR, HOOK_TIMEOUT_S } from './defaults.js';

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

export function buildPreToolUseHooks(toolsList: string[]) {
  const hooks: ClaudeMatcherGroup[] = [
    { matcher: 'Edit|Write', hooks: [
      nodeHook('sensitive-file-edit.mjs', 10),
      nodeHook('tasks-yaml-guard.mjs', 10),
    ]},
  ];
  if (toolsList.includes('AskUserQuestion')) {
    hooks.push({ matcher: 'AskUserQuestion', hooks: [nodeHook('ask-user-question-hook.mjs', HOOK_TIMEOUT_S)] });
  }
  if (toolsList.includes('ExitPlanMode')) {
    hooks.push({ matcher: 'ExitPlanMode', hooks: [nodeHook('exit-plan-mode-hook.mjs', HOOK_TIMEOUT_S)] });
  }
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

export const PERMISSION_REQUEST_HOOKS = [
  {
    matcher: 'Edit|Write',
    hooks: [{
      type: 'command' as const,
      command: "printf '{\"hookSpecificOutput\":{\"hookEventName\":\"PermissionRequest\",\"decision\":{\"behavior\":\"allow\"}}}'",
      timeout: 5,
    }],
  },
];

export const SESSION_START_HOOKS = [
  { matcher: 'startup|resume|clear|compact', hooks: [nodeHook('cortex-md-injector.mjs')] },
];

function buildLegacyHooksSettings(toolsList: string[]): ClaudeHooksSettings {
  return {
    PreToolUse: buildPreToolUseHooks(toolsList),
    PostToolUse: POST_TOOL_USE_HOOKS,
    PermissionRequest: PERMISSION_REQUEST_HOOKS,
    SessionStart: SESSION_START_HOOKS,
  };
}

function claudeEventName(event: HookEntry['event']): string | null {
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
  const settings: ClaudeHooksSettings = {};
  for (const entry of entries) {
    const event = claudeEventName(entry.event);
    if (event !== null) appendEntry(settings, event, entry);
  }
  return settings;
}

export function buildHooksSettings(tools: string | null) {
  const toolsList = (tools || DEFAULT_TOOLS).split(',').map((tool) => tool.trim());
  if (process.env.CORTEX_HOOKS_LEGACY === '1') return buildLegacyHooksSettings(toolsList);
  return compileRegistryHooks(toolsList);
}
