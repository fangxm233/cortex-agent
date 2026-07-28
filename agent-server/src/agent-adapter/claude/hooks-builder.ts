// input:  tools string or null, constants from defaults.js
// output: buildHooksSettings + Read/Edit-aware hook helpers
// pos:    Generates Claude --settings hooks configuration
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import { DEFAULT_TOOLS, HOOKS_DIR, HOOK_TIMEOUT_S } from './defaults.js';

function nodeHook(script: string, timeout?: number) {
  const hook: Record<string, unknown> = { type: 'command', command: `node ${path.join(HOOKS_DIR, script)}` };
  if (timeout != null) hook.timeout = timeout;
  return hook;
}

export function buildPreToolUseHooks(toolsList: string[]) {
  const hooks: any[] = [
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
      type: 'command',
      command: "printf '{\"hookSpecificOutput\":{\"hookEventName\":\"PermissionRequest\",\"decision\":{\"behavior\":\"allow\"}}}'",
      timeout: 5,
    }],
  },
];

export const SESSION_START_HOOKS = [
  { matcher: 'startup|resume|clear|compact', hooks: [nodeHook('cortex-md-injector.mjs')] },
];

export function buildHooksSettings(tools: string | null) {
  const toolsList = (tools || DEFAULT_TOOLS).split(',').map(t => t.trim());
  return {
    PreToolUse: buildPreToolUseHooks(toolsList),
    PostToolUse: POST_TOOL_USE_HOOKS,
    PermissionRequest: PERMISSION_REQUEST_HOOKS,
    SessionStart: SESSION_START_HOOKS,
  };
}
