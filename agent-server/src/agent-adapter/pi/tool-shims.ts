// input:  PI model registry, session env, subagent event sink, Agent, todo and web tools
// output: Gated runtime Agent (over nested sessions), todo, and web tools
// pos:    Registers PI-local tool shims
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { Type } from '@sinclair/typebox';
import type { ExtensionAPI, ExtensionContext, InlineExtension } from '@earendil-works/pi-coding-agent';
import { PI_AGENT_DIR, ensurePIAgentRoles } from './agent-dir.js';
import { createChildSession, type ChildSessionFactory } from './child-session.js';
import type { SubagentNotice } from './event-parser.js';
import { createMcpBridgeDeps, installMcpBridge } from './mcp-bridge.js';
import { createSubagentTool, type SubagentModelOption } from './subagent.js';
import { webFetchTool } from './web-fetch.js';
import { webSearchTool } from './web-search.js';

export interface ToolShimHooks {
  /** Receives each event a subagent forwards for the parent's transcript. */
  onSubagentEvent?: (notice: SubagentNotice) => void;
  /** Nested session factory for subagents; tests substitute a fake. */
  createChildSession?: ChildSessionFactory;
}

const TodoWriteParameters = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: 'Task description (imperative form).' }),
      status: Type.Union([
        Type.Literal('pending'),
        Type.Literal('in_progress'),
        Type.Literal('completed'),
      ]),
      activeForm: Type.String({
        description: 'Present-continuous form shown when the task is in progress.',
      }),
    }),
  ),
});

function registerTodoWrite(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'todo_write',
    label: 'TodoWrite',
    description:
      'Create and manage a structured task list for the current session. ' +
      'Use this to track progress across multi-step tasks.',
    parameters: TodoWriteParameters,
    async execute(_id, params) {
      const total = params.todos.length;
      const done = params.todos.filter((todo) => todo.status === 'completed').length;
      const inProgress = params.todos.filter((todo) => todo.status === 'in_progress').length;
      return {
        content: [{
          type: 'text',
          text: `Todos updated: ${total} total, ${done} completed, ${inProgress} in progress.`,
        }],
        details: undefined,
      };
    },
  });
}

function runtimeModelOptions(ctx: ExtensionContext): SubagentModelOption[] {
  const available = ctx.modelRegistry?.getAvailable() ?? [];
  const models = ctx.model ? [...available, ctx.model] : available;
  return models.map((model) => ({ provider: model.provider, id: model.id }));
}

/** The extensions a subagent session runs with: the Cortex MCP bridge and these shims, both closed
 *  over the child's own env. Its subagent marker keeps the Agent tool out of the child, and its
 *  stripped scope keeps the child's bridge to the core bundle. */
function childExtensions(env: NodeJS.ProcessEnv): InlineExtension[] {
  return [
    { name: 'cortex-mcp-bridge', factory: (pi) => installMcpBridge(pi, createMcpBridgeDeps(env, [])) },
    { name: 'cortex-tool-shims', factory: (pi) => installToolShims(pi, env) },
  ];
}

function registerRuntimeAgent(pi: ExtensionAPI, env: NodeJS.ProcessEnv, hooks: ToolShimHooks): void {
  const agentDir = env.PI_CODING_AGENT_DIR ?? PI_AGENT_DIR;
  pi.on('session_start', (_event, ctx) => {
    pi.registerTool(createSubagentTool({
      agentDir,
      ensureRoles: () => ensurePIAgentRoles({ agentDir }),
      createSession: hooks.createChildSession ?? createChildSession,
      childExtensions,
      parentEnv: env,
      onEvent: hooks.onSubagentEvent,
    }, runtimeModelOptions(ctx)));
  });
}

/** Every shim this extension can register, by PI-native name and its Claude-native label. */
const SHIM_REGISTRATIONS: Array<[native: string, label: string, register: (pi: ExtensionAPI) => void]> = [
  ['web_fetch', 'WebFetch', pi => pi.registerTool(webFetchTool)],
  ['web_search', 'WebSearch', pi => pi.registerTool(webSearchTool)],
  ['todo_write', 'TodoWrite', registerTodoWrite],
];

function allowedToolLabels(env: NodeJS.ProcessEnv): Set<string> | null {
  const value = env.CORTEX_PI_ALLOWED_TOOLS?.trim();
  if (!value) return null;
  return new Set(value.split(',').map(tool => tool.trim()).filter(Boolean));
}

export function installToolShims(pi: ExtensionAPI, env: NodeJS.ProcessEnv, hooks: ToolShimHooks = {}): void {
  const allowed = allowedToolLabels(env);
  const includes = (label: string): boolean => allowed === null || allowed.has(label);
  if (includes('Agent') && env.CORTEX_PI_SUBAGENT !== '1') registerRuntimeAgent(pi, env, hooks);
  for (const [, label, register] of SHIM_REGISTRATIONS) {
    if (includes(label)) register(pi);
  }
}
