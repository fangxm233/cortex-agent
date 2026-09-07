// input:  PI model registry, Agent, todo and web tools
// output: Gated runtime Agent, todo, and web tools
// pos:    Registers PI-local tool shims
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { Type } from '@sinclair/typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createSubagentTool, type SubagentModelOption } from './subagent.js';
import { webFetchTool } from './web-fetch.js';
import { webSearchTool } from './web-search.js';

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

function registerRuntimeAgent(pi: ExtensionAPI): void {
  pi.on('session_start', (_event, ctx) => {
    pi.registerTool(createSubagentTool(undefined, runtimeModelOptions(ctx)));
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

export function installToolShims(pi: ExtensionAPI, env: NodeJS.ProcessEnv): void {
  const allowed = allowedToolLabels(env);
  const includes = (label: string): boolean => allowed === null || allowed.has(label);
  if (includes('Agent') && env.CORTEX_PI_SUBAGENT !== '1') registerRuntimeAgent(pi);
  for (const [, label, register] of SHIM_REGISTRATIONS) {
    if (includes(label)) register(pi);
  }
}

export default function toolShims(pi: ExtensionAPI): void {
  installToolShims(pi, process.env);
}
