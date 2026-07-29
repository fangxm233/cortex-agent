// input:  PI model registry, Agent/web tools, filesystem paths
// output: Gated runtime Agent, interaction, todo, and web tools
// pos:    PI extension bridge for Cortex tool shims
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { mkdirSync } from 'fs';
import * as path from 'path';
import { Type } from '@sinclair/typebox';
import type { ExtensionAPI, ExtensionContext } from './pi-ext-types.js';
import { createSubagentTool, type SubagentModelOption } from './subagent.js';
import { webFetchTool } from './web-fetch.js';
import { webSearchTool } from './web-search.js';

const AskUserQuestionParameters = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: 'The complete question to ask the user.' }),
      header: Type.String({ description: 'Very short label (max 12 chars), e.g. "Auth method", "Library".' }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: 'The display text for this option.' }),
          description: Type.String({ description: 'Explanation of what this option means.' }),
        }),
        { description: 'Available choices. Must have 2-4 options.' },
      ),
      multiSelect: Type.Boolean({
        default: false,
        description: 'If true, the user may select multiple options.',
      }),
    }),
    { description: 'Questions to ask (1-4 questions).' },
  ),
});

const EnterPlanModeDescription =
  'Use this tool proactively when you are about to start a non-trivial implementation task. ' +
  'Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. ' +
  'This tool transitions you into plan mode where you explore the codebase and design an implementation approach for user approval.\n\n' +
  '## When to Use This Tool\n\n' +
  'Use when ANY of these conditions apply:\n' +
  '1. New Feature Implementation — adding meaningful new functionality\n' +
  '2. Multiple Valid Approaches — the task can be solved in several different ways\n' +
  '3. Code Modifications — changes that affect existing behavior or structure\n' +
  '4. Architectural Decisions — choosing between patterns or technologies\n' +
  '5. Multi-File Changes — the task will likely touch more than 2-3 files\n' +
  '6. Unclear Requirements — you need to explore before understanding the full scope\n' +
  '7. User Preferences Matter — the implementation could reasonably go multiple ways\n\n' +
  '## When NOT to Use This Tool\n\n' +
  'Skip for simple tasks: single-line or few-line fixes, adding a single function with clear requirements, ' +
  'tasks where the user has given very specific detailed instructions, or pure research/exploration tasks.';

const PlanModeBody = [
  '',
  'IMPORTANT: You MUST write the plan content to the provided plan file before calling ExitPlanMode.',
  '',
  '## Rules',
  '',
  '1. Do NOT use Edit, Write, or Bash to modify any files or run destructive commands.',
  '2. Use ONLY read-only tools to explore the codebase: Read, Grep, Glob, Bash (read-only commands like ls, git log, etc.), WebSearch, WebFetch.',
  '3. Use the Agent tool with subagent_type "explore" for broader codebase exploration if needed.',
  '4. Use AskUserQuestion if you need to clarify requirements or choose between approaches.',
  '5. Once you have a complete plan, write it to the plan file above using the Write tool.',
  '6. After writing the plan file, call ExitPlanMode to submit it for user approval.',
  '',
  '## What Your Plan Should Include',
  '',
  '- Summary of the task and your understanding of requirements',
  '- Key files and components that will be affected',
  '- Step-by-step implementation approach',
  '- Any risks, trade-offs, or alternatives considered',
  '- Test plan (if applicable)',
  '',
  'Begin by exploring the codebase to understand the relevant code and architecture.',
];

const ExitPlanModeParameters = Type.Object({
  plan: Type.Optional(
    Type.String({ description: 'Summary of the plan content (also written to file).' }),
  ),
});

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

/** Match Claude-native labels against the active agent's comma-separated allowlist. */
export function makeToolGate(allowedToolsEnv: string | undefined): (label: string) => boolean {
  if (!allowedToolsEnv || allowedToolsEnv.trim() === '') return () => true;
  const allowed = new Set(
    allowedToolsEnv.split(',').map((tool) => tool.trim()).filter(Boolean),
  );
  return (label: string): boolean => allowed.has(label);
}

function registerAskUserQuestion(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'ask_user_question',
    label: 'AskUserQuestion',
    description:
      'Ask the user one or more questions and wait for their responses before proceeding. ' +
      'Use this when you need clarification, a decision, or a choice from the user.',
    parameters: AskUserQuestionParameters,
    async execute(_id, params, _signal, _update, ctx) {
      const summary = params.questions.map((question) => question.header || question.question).join(', ');
      const answer = await ctx.ui.input(`Waiting for user: ${summary}`);
      return { content: [{ type: 'text', text: answer || '(no answer provided)' }] };
    },
  });
}

function planModeInstructions(planFilePath: string): string {
  return [
    'You are now in plan mode. Your goal is to explore the codebase and design an implementation approach before making any changes.',
    '',
    `Plan file: ${planFilePath}`,
    ...PlanModeBody,
  ].join('\n');
}

function registerEnterPlanMode(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'enter_plan_mode',
    label: 'EnterPlanMode',
    description: EnterPlanModeDescription,
    parameters: Type.Object({}),
    async execute() {
      const planDir = path.join(process.cwd(), 'plan');
      try { mkdirSync(planDir, { recursive: true }); } catch {}
      const planFilePath = path.join(planDir, `plan-${Date.now()}.md`);
      return { content: [{ type: 'text', text: planModeInstructions(planFilePath) }] };
    },
  });
}

function registerExitPlanMode(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'exit_plan_mode',
    label: 'ExitPlanMode',
    description:
      'Signal that you have finished planning and are ready to submit the plan for user approval. ' +
      'Call this after writing your plan to a file. Execution will pause until the user approves.',
    parameters: ExitPlanModeParameters,
    async execute(_id, _params, _signal, _update, ctx) {
      const response = await ctx.ui.input(
        "Plan review — type '__APPROVED__' to proceed or provide feedback.",
      );
      if (response === '__APPROVED__') {
        return { content: [{ type: 'text', text: 'Plan approved. Proceeding with implementation.' }] };
      }
      if (response) {
        return { content: [{ type: 'text', text: `Plan needs revision. User feedback:\n"""\n${response}\n"""` }] };
      }
      return {
        content: [{ type: 'text', text: 'Plan rejected. Please revise the plan and try again.' }],
      };
    },
  });
}

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

export default function toolShims(pi: ExtensionAPI): void {
  const allowed = makeToolGate(process.env.CORTEX_PI_ALLOWED_TOOLS);
  if (allowed('Agent') && process.env.CORTEX_PI_SUBAGENT !== '1') registerRuntimeAgent(pi);
  const registrations: Array<[string, () => void]> = [
    ['WebFetch', () => pi.registerTool(webFetchTool)],
    ['WebSearch', () => pi.registerTool(webSearchTool)],
    ['AskUserQuestion', () => registerAskUserQuestion(pi)],
    ['EnterPlanMode', () => registerEnterPlanMode(pi)],
    ['ExitPlanMode', () => registerExitPlanMode(pi)],
    ['TodoWrite', () => registerTodoWrite(pi)],
  ];
  for (const [label, register] of registrations) {
    if (allowed(label)) register();
  }
}
