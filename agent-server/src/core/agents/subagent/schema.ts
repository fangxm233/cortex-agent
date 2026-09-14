import type { Backend } from '@core/types/agent-types.js';
import type { Invocation, SubagentMode, SubagentTask } from './types.js';

export const MAX_SUBAGENT_TASKS = 8;
/** One daemon-wide ceiling for both backends. A `claude` child is a CLI subprocess and a `pi`
 *  child a nested in-process session, but the cap is deliberately the same number. */
export const MAX_SUBAGENT_CONCURRENCY = 8;

export const SUBAGENT_MODEL_DESCRIPTION =
  'Optional model override: provider/model[:thinking] for a pi child, a bare model id for a claude '
  + 'child. Omit to use the role model, then the parent\'s current model.';

export const SUBAGENT_BACKEND_DESCRIPTION =
  'Optional backend for this child: "claude" or "pi". Omit to use the role\'s backend, then the '
  + 'parent\'s own.';

export const SUBAGENT_DESCRIPTION =
  'Delegate a task to an isolated subagent. Supports single, parallel, and chain modes, and can '
  + 'run the child on either backend.';

const TASK_KEYS = ['description', 'prompt', 'subagent_type'] as const;

export function parseBackendField(value: unknown, where: string): Backend | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'claude' || value === 'pi') return value;
  throw new Error(`${where} backend must be "claude" or "pi".`);
}

function validateTask(task: SubagentTask): void {
  for (const key of TASK_KEYS) {
    if (typeof task[key] !== 'string' || task[key].trim() === '') {
      throw new Error(`Agent task requires a non-empty ${key}.`);
    }
  }
  parseBackendField((task as unknown as Record<string, unknown>).backend, 'Agent task');
}

function checkedInvocation(mode: SubagentMode, tasks: SubagentTask[]): Invocation {
  if (tasks.length === 0) throw new Error(`${mode} requires at least one task.`);
  if (tasks.length > MAX_SUBAGENT_TASKS) {
    throw new Error(`Agent ${mode} task maximum is ${MAX_SUBAGENT_TASKS}.`);
  }
  for (const task of tasks) validateTask(task);
  return { mode, tasks };
}

/** Exactly one of: the single-mode fields, `parallel`, or `chain`. */
export function resolveInvocation(params: unknown): Invocation {
  const record = (params ?? {}) as Record<string, unknown>;
  const hasSingle = TASK_KEYS.some((key) => key in record);
  const hasParallel = Array.isArray(record.parallel);
  const hasChain = Array.isArray(record.chain);
  if (Number(hasSingle) + Number(hasParallel) + Number(hasChain) !== 1) {
    throw new Error('Provide exactly one Agent mode: single fields, parallel, or chain.');
  }
  if (hasParallel) return checkedInvocation('parallel', record.parallel as SubagentTask[]);
  if (hasChain) return checkedInvocation('chain', record.chain as SubagentTask[]);
  const task = record as unknown as SubagentTask;
  validateTask(task);
  return { mode: 'single', tasks: [task] };
}
