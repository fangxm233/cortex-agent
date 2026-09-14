// input:  PI `agent` tool calls, the shared role/model catalog, a nested PI session factory
// output: Single, parallel and chain subagent runs with attributed child events and usage
// pos:    PI `agent` tool: runs role-scoped subagents, locally or on the other backend
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { Type } from '@sinclair/typebox';
import type { ExtensionContext, InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { findRole, loadRoles, type AgentRole } from '@core/agents/roles.js';
import {
  MAX_SUBAGENT_TASKS, SUBAGENT_DESCRIPTION, resolveInvocation,
} from '@core/agents/subagent/schema.js';
import {
  describeSubagent, type SubagentCatalog, type SubagentFieldDescriptions,
} from '@core/agents/subagent/catalog.js';
import { endStatusOf, failedChildResult, runInvocation } from '@core/agents/subagent/orchestrate.js';
import type {
  ChildEventForwarder, Invocation, RunChildFn, SubagentDetails, SubagentEndStatus, SubagentResult,
  SubagentTask,
} from '@core/agents/subagent/types.js';
import type { Backend } from '../types.js';
import type { ChildSessionFactory } from './child-session.js';
import type {
  StartBackgroundSubagent, StopBackgroundSubagent,
} from './background-subagent.js';
import { subagentChannel, subagentEndNotice } from './child-events.js';
import { runPiChild, selectPiModel } from './child-runner.js';
import type { SubagentNotice } from './event-parser.js';

export { MAX_SUBAGENT_TASKS, MAX_SUBAGENT_CONCURRENCY } from '@core/agents/subagent/schema.js';
export {
  MAX_SUBAGENT_MODEL_CHOICES, MAX_SUBAGENT_MODEL_LIST_CHARS,
} from '@core/agents/subagent/catalog.js';
export type { SubagentModelOption } from '@core/agents/subagent/catalog.js';

/** The field descriptions track the live catalog, so the schema is built per tool instead of being
 *  frozen at import time. */
function buildSubagentParameters(described: SubagentFieldDescriptions) {
  const BackendSchema = Type.Union([Type.Literal('claude'), Type.Literal('pi')], {
    description: described.backend,
  });
  const TaskSchema = Type.Object({
    description: Type.String({ description: 'Short description of the delegated task.' }),
    prompt: Type.String({ description: 'Complete task prompt for the subagent.' }),
    subagent_type: Type.String({ description: described.subagentType }),
    model: Type.Optional(Type.String({ description: described.model })),
    backend: Type.Optional(BackendSchema),
  });
  return Type.Object({
    description: Type.Optional(Type.String({ description: 'Short description for single mode.' })),
    prompt: Type.Optional(Type.String({ description: 'Complete prompt for single mode.' })),
    subagent_type: Type.Optional(Type.String({ description: described.subagentTypeSingle })),
    model: Type.Optional(Type.String({ description: described.model })),
    backend: Type.Optional(BackendSchema),
    parallel: Type.Optional(Type.Array(TaskSchema, {
      minItems: 1,
      maxItems: MAX_SUBAGENT_TASKS,
      description: 'Tasks to execute concurrently.',
    })),
    chain: Type.Optional(Type.Array(TaskSchema, {
      minItems: 1,
      maxItems: MAX_SUBAGENT_TASKS,
      description: 'Tasks to execute sequentially; {previous} inserts the prior output.',
    })),
    run_in_background: Type.Optional(Type.Boolean({
      description: 'Return an agent_id immediately and deliver the result when it is ready, instead '
        + 'of blocking this tool call. Use for long work you can carry on without.',
    })),
  });
}

type SubagentParametersSchema = ReturnType<typeof buildSubagentParameters>;

const StopParameters = Type.Object({
  agent_id: Type.String({ description: 'The agent_id returned when the subagent was started.' }),
});

/** What the delegating PI session can tell the runner about itself. A child on the same backend
 *  inherits this routing; a child on the other backend resolves its own. */
export interface ForeignSubagentParent {
  backend: Backend;
  model?: string | null;
  provider?: string | null;
  /** The parent session's env, from which a nested `pi` child derives its own. */
  env: NodeJS.ProcessEnv;
}

/** One child this session cannot run itself, handed to the daemon-side runner. */
export interface ForeignSubagentRequest {
  task: SubagentTask;
  role: AgentRole;
  backend: Backend;
  cwd: string;
  /** Attribution block key, `${parentToolCallId}#${childIndex}`. */
  ref: string;
  parent: ForeignSubagentParent;
  signal?: AbortSignal;
  onNotice?: (notice: SubagentNotice) => void;
}

export type RunForeignSubagent = (request: ForeignSubagentRequest) => Promise<SubagentResult>;

export interface SubagentToolDeps {
  /** PI agent dir whose auth/models the `pi` children use. */
  agentDir: string;
  /** Where the shared role files live; defaults to the registry's own location. */
  rolesDir?: string;
  ensureRoles(): void;
  /** Creates one nested in-process PI session per `pi` child. */
  createSession: ChildSessionFactory;
  /** The Cortex extensions a child session runs with, closed over the child's env. */
  childExtensions: (env: NodeJS.ProcessEnv) => InlineExtension[];
  /** The parent session's env; each child's env is derived from it. */
  parentEnv: NodeJS.ProcessEnv;
  /** Receives every forwarded child event for the parent's transcript. Absent: no attribution. */
  onEvent?: (notice: SubagentNotice) => void;
  /** Runs children whose backend is not `pi`. Absent: such a task is an error, not a silent
   *  downgrade — a role asking for `claude` must not quietly answer from a PI model. */
  runForeignSubagent?: RunForeignSubagent;
  /** Registers a backgrounded run with the daemon. Absent: `run_in_background` is refused rather
   *  than silently downgraded to a blocking run, which would strand the caller for minutes. */
  startBackgroundSubagent?: StartBackgroundSubagent;
  /** Stops a backgrounded run by id. Absent: `agent_stop` is not registered at all. */
  stopBackgroundSubagent?: StopBackgroundSubagent;
}

export type {
  SubagentResult, SubagentUsage, SubagentDetails,
} from '@core/agents/subagent/types.js';

function fallbackModel(ctx: ExtensionContext) {
  return ctx.model ? { id: ctx.model.id, provider: ctx.model.provider } : null;
}

/** Task → role → this session's own backend. A `pi` session is the parent here by construction. */
function resolveBackend(task: SubagentTask, role: AgentRole): Backend {
  return task.backend ?? role.backend ?? 'pi';
}

function buildRunChild(
  ctx: ExtensionContext,
  deps: SubagentToolDeps,
  roles: AgentRole[],
  parentToolCallId: string,
) {
  return async (
    task: SubagentTask,
    index: number,
    signal: AbortSignal | undefined,
    forward?: ChildEventForwarder,
  ): Promise<SubagentResult> => {
    const role = findRole(roles, task.subagent_type);
    const backend = resolveBackend(task, role);
    const ref = `${parentToolCallId}#${index}`;
    // Seal the child's transcript block on settle — the only signal that a delegated child is
    // over. Its own events say nothing about it (a PI child just stops forwarding), and the
    // parent acting again proves nothing, so without this the block runs until the session idles.
    const seal = (status: SubagentEndStatus): void => {
      try { deps.onEvent?.(subagentEndNotice(ref, task, backend, status)); }
      catch { /* attribution is best-effort; the run itself must not fail for it */ }
    };
    try {
      const result = backend === 'pi'
        ? await runPiChild({
          task, role, cwd: ctx.cwd, agentDir: deps.agentDir, parentEnv: deps.parentEnv,
          fallbackModel: fallbackModel(ctx), createSession: deps.createSession,
          childExtensions: deps.childExtensions, signal, forward,
        })
        : await runForeignChild(ctx, deps, task, role, backend, ref, signal);
      seal(endStatusOf(result));
      return result;
    } catch (error) {
      if (signal?.aborted) { seal('killed'); throw error; }
      seal('failed');
      return failedChildResult(task, error);
    }
  };
}

/** A child on the other backend: same contract, run by the daemon rather than in this process. */
function runForeignChild(
  ctx: ExtensionContext,
  deps: SubagentToolDeps,
  task: SubagentTask,
  role: AgentRole,
  backend: Backend,
  ref: string,
  signal: AbortSignal | undefined,
): Promise<SubagentResult> {
  if (!deps.runForeignSubagent) {
    throw new Error(`Delegating to the ${backend} backend is unavailable in this session.`);
  }
  const parent = fallbackModel(ctx);
  return deps.runForeignSubagent({
    task, role, backend, cwd: ctx.cwd, ref,
    parent: {
      backend: 'pi', model: parent?.id ?? null, provider: parent?.provider ?? null,
      env: deps.parentEnv,
    },
    signal, onNotice: deps.onEvent,
  });
}

function textResult(text: string): { content: Array<{ type: 'text'; text: string }>; details: undefined } {
  return { content: [{ type: 'text', text }], details: undefined };
}

/**
 * Hand the run to the daemon and answer with its id.
 *
 * The tool call returns now, so nothing from this point on may depend on the call's own `signal`
 * (already aborting) or on `ctx` surviving — the child runner closes over the values it needs. The
 * attribution channel is still worth wiring: the parent's turn usually outlives the tool call, and
 * while it does the children's work streams into the transcript exactly as a foreground run's does.
 */
async function startInBackground(
  deps: SubagentToolDeps,
  invocation: Invocation,
  runChild: RunChildFn,
  toolCallId: string,
) {
  if (!deps.startBackgroundSubagent) {
    throw new Error('run_in_background is unavailable in this session.');
  }
  const { id } = await deps.startBackgroundSubagent({
    invocation,
    runChild,
    channel: subagentChannel(toolCallId, deps.onEvent, invocation.mode === 'chain'),
    sessionId: deps.parentEnv.CORTEX_SESSION_ID || null,
    conduit: deps.parentEnv.SLACK_CHANNEL || deps.parentEnv.FEISHU_CHANNEL || undefined,
  });
  return textResult(
    `Agent ${id} started in the background. Its result will be delivered to you when it is ready. `
    + `Stop it early with agent_stop("${id}").`,
  );
}

export function createSubagentTool(
  deps: SubagentToolDeps,
  catalog: SubagentCatalog = {},
): ToolDefinition<SubagentParametersSchema, SubagentDetails> {
  const described = describeSubagent(catalog);
  return {
    name: 'agent',
    label: 'Agent',
    description: SUBAGENT_DESCRIPTION,
    parameters: buildSubagentParameters(described),
    async execute(toolCallId, params, signal, _update, ctx) {
      deps.ensureRoles();
      const invocation = resolveInvocation(params);
      const roles = loadRoles(deps.rolesDir);
      // Fail before any child starts if a role is missing: a half-run fan-out is worse than none.
      for (const task of invocation.tasks) findRole(roles, task.subagent_type);
      const runChild = buildRunChild(ctx, deps, roles, toolCallId);
      if (params.run_in_background) {
        return startInBackground(deps, invocation, runChild, toolCallId);
      }
      return runInvocation(
        invocation,
        runChild,
        signal,
        subagentChannel(toolCallId, deps.onEvent, invocation.mode === 'chain'),
      );
    },
  };
}

/** The sibling of `run_in_background`: registered only when the session can background a run at
 *  all, since an id it could never have been given is nothing to stop. */
export function createSubagentStopTool(
  deps: SubagentToolDeps,
): ToolDefinition<typeof StopParameters, SubagentDetails> | null {
  const stop = deps.stopBackgroundSubagent;
  if (!stop) return null;
  return {
    name: 'agent_stop',
    label: 'AgentStop',
    description:
      'Stop a running subagent by the agent_id you were given. Whatever the children had produced '
      + 'is discarded — use it when the delegated work is no longer wanted, not to collect a result.',
    parameters: StopParameters,
    async execute(_toolCallId, params) {
      const status = await stop(params.agent_id);
      if (!status) return textResult(`No such agent run: ${params.agent_id}.`);
      return textResult(`Agent ${params.agent_id} is now ${status}.`);
    },
  };
}

export { selectPiModel };
export { subagentChannel } from './child-events.js';
