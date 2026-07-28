// input:  PI ExtensionAPI, TypeBox, web-fetch, filesystem paths
// output: Gated interaction, task-tracking, and WebFetch tools
// pos:    PI extension bridge for Cortex interaction flows
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ExtensionAPI } from './pi-ext-types.js';
import { webFetchTool } from './web-fetch.js';
import { Type } from '@sinclair/typebox';
import * as path from 'path';
import { mkdirSync } from 'fs';

/**
 * Build a predicate that decides whether a pseudo-tool (identified by its Claude-native label,
 * e.g. "ExitPlanMode") may be registered, given the agent's tool allowlist.
 *
 * `allowedToolsEnv` mirrors the agent's `tools` config in Claude-native, comma-separated form —
 * the PI adapter forwards it via the CORTEX_PI_ALLOWED_TOOLS env var, exactly the same allowlist
 * the Claude backend passes to `--tools`. When unset/empty (interactive sessions, or callers that
 * don't constrain tools) ALL pseudo-tools are allowed, preserving prior behavior.
 *
 * This is what stops thread-dispatched agents (coder, reviewer, …) from being handed
 * AskUserQuestion / EnterPlanMode / ExitPlanMode — interaction tools that deadlock a headless
 * thread because no human can ever answer the approval prompt.
 */
export function makeToolGate(allowedToolsEnv: string | undefined): (label: string) => boolean {
  if (!allowedToolsEnv || allowedToolsEnv.trim() === '') return () => true;
  const allowed = new Set(
    allowedToolsEnv.split(',').map((t) => t.trim()).filter((t) => t.length > 0),
  );
  return (label: string): boolean => allowed.has(label);
}

export default function toolShims(pi: ExtensionAPI): void {
  // Gate pseudo-tool registration on the agent's tool allowlist (Claude-native labels).
  // Mirrors the Claude backend's `--tools` allowlist so PI honors the same per-agent tool scoping.
  const allowed = makeToolGate(process.env.CORTEX_PI_ALLOWED_TOOLS);
  if (allowed('WebFetch')) pi.registerTool(webFetchTool);

  // ---------------------------------------------------------------------------
  // ask_user_question
  // ---------------------------------------------------------------------------
  // Schema mirrors Claude's native AskUserQuestion so the LLM produces identical
  // output regardless of backend.  The tool shim calls ctx.ui.input() ONCE as a
  // blocking primitive; the Cortex adapter posts all questions to Slack from the
  // tool_use event (which carries the full input), then unblocks via
  // sendExtensionUiResponse when the user answers.
  if (allowed('AskUserQuestion')) pi.registerTool({
    name: 'ask_user_question',
    label: 'AskUserQuestion',
    description:
      'Ask the user one or more questions and wait for their responses before proceeding. ' +
      'Use this when you need clarification, a decision, or a choice from the user.',
    parameters: Type.Object({
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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Block once via ctx.ui.input — Cortex adapter handles multi-question
      // display and answer collection through Slack, then unblocks this call
      // with the combined answers via sendExtensionUiResponse.
      const summary = params.questions.map((q) => q.header || q.question).join(', ');
      const answer = await ctx.ui.input(`Waiting for user: ${summary}`);
      return { content: [{ type: 'text', text: answer || '(no answer provided)' }] };
    },
  });

  // ---------------------------------------------------------------------------
  // enter_plan_mode
  // ---------------------------------------------------------------------------
  // Mirrors Claude Code's native EnterPlanMode. When the LLM calls this tool,
  // it receives plan-mode instructions: explore the codebase with read-only
  // tools, write the plan to a designated file, then call exit_plan_mode.
  // Non-interactive: returns the plan-mode instructions immediately.
  // The event-parser emits a plan_mode_entered NormalizedEvent for observability.
  if (allowed('EnterPlanMode')) pi.registerTool({
    name: 'enter_plan_mode',
    label: 'EnterPlanMode',
    description:
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
      'tasks where the user has given very specific detailed instructions, or pure research/exploration tasks.',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      // Generate a plan file path under plan/ with a timestamp.
      const planDir = path.join(process.cwd(), 'plan');
      try { mkdirSync(planDir, { recursive: true }); } catch {}
      const planFileName = `plan-${Date.now()}.md`;
      const planFilePath = path.join(planDir, planFileName);

      const instructions = [
        'You are now in plan mode. Your goal is to explore the codebase and design an implementation approach before making any changes.',
        '',
        `Plan file: ${planFilePath}`,
        '',
        'IMPORTANT: You MUST write the plan content to the provided plan file before calling ExitPlanMode.',
        '',
        '## Rules',
        '',
        '1. Do NOT use Edit, Write, or Bash to modify any files or run destructive commands.',
        '2. Use ONLY read-only tools to explore the codebase: Read, Grep, Glob, Bash (read-only commands like ls, git log, etc.), WebSearch, WebFetch.',
        '3. Use the Agent tool with subagent_type "Explore" for broader codebase exploration if needed.',
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
      ].join('\n');

      return { content: [{ type: 'text', text: instructions }] };
    },
  });

  // ---------------------------------------------------------------------------
  // exit_plan_mode
  // ---------------------------------------------------------------------------
  // Registers a pseudo-tool that signals "planning complete, submit for review".
  // The event-parser emits a plan_written NormalizedEvent from tool_execution_start
  // (using state.pendingPlanPath set by a preceding Write call to a plan directory).
  // After that, this shim calls ctx.ui.input to block PI until Cortex delivers the
  // user's approval (value='__APPROVED__') or rejection (value=<feedback> / cancelled).
  // On approval, PI is unblocked and continues to the implementation phase.
  // On rejection, returns a rejection message so PI can revise the plan.
  if (allowed('ExitPlanMode')) pi.registerTool({
    name: 'exit_plan_mode',
    label: 'ExitPlanMode',
    description:
      'Signal that you have finished planning and are ready to submit the plan for user approval. ' +
      'Call this after writing your plan to a file. Execution will pause until the user approves.',
    parameters: Type.Object({
      plan: Type.Optional(
        Type.String({ description: 'Summary of the plan content (also written to file).' }),
      ),
    }),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      // Block until the user approves or rejects the plan via Cortex approval UI.
      // The Cortex adapter responds with sendExtensionUiResponse({ value: '__APPROVED__' }) for approval, or { value: '<feedback>' } / { cancelled: true } for rejection.
      const response = await ctx.ui.input(
        'Plan review — type "__APPROVED__" to proceed or provide feedback.',
      );
      if (response === '__APPROVED__') {
        return { content: [{ type: 'text', text: 'Plan approved. Proceeding with implementation.' }] };
      }
      if (response) {
        return { content: [{ type: 'text', text: `Plan needs revision. User feedback:\n"""\n${response}\n"""` }] };
      }
      // null / undefined (cancelled) treated as rejected without feedback.
      return {
        content: [{ type: 'text', text: 'Plan rejected. Please revise the plan and try again.' }],
      };
    },
  });

  // ---------------------------------------------------------------------------
  // todo_write
  // ---------------------------------------------------------------------------
  // Registers a pseudo-tool that tracks the agent's task list in-context.
  // Non-interactive: just acknowledges the update and returns. The event-parser
  // emits a regular tool_use NormalizedEvent (no special NormalizedEvent type).
  // The LLM uses this to visibly manage its work checklist across steps.
  if (allowed('TodoWrite')) pi.registerTool({
    name: 'todo_write',
    label: 'TodoWrite',
    description:
      'Create and manage a structured task list for the current session. ' +
      'Use this to track progress across multi-step tasks.',
    parameters: Type.Object({
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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const total = params.todos.length;
      const done = params.todos.filter((t) => t.status === 'completed').length;
      const inProgress = params.todos.filter((t) => t.status === 'in_progress').length;
      return {
        content: [
          {
            type: 'text',
            text: `Todos updated: ${total} total, ${done} completed, ${inProgress} in progress.`,
          },
        ],
      };
    },
  });
}
