import type { Backend } from '@core/types/agent-types.js';
import type { Invocation, SubagentMode, SubagentTask } from './types.js';

export const MAX_SUBAGENT_TASKS = 8;
/** One daemon-wide ceiling for both backends. A `claude` child is a CLI subprocess and a `pi`
 *  child a nested in-process session, but the cap is deliberately the same number. */
export const MAX_SUBAGENT_CONCURRENCY = 8;

export const SUBAGENT_MODEL_DESCRIPTION =
  'Model override: pi provider/model[:thinking], claude model ID. Default: role model, then parent model.';

export const SUBAGENT_BACKEND_DESCRIPTION =
  'Backend override. Default: role backend, then parent backend.';

export const SUBAGENT_DESCRIPTION =
  'Delegate isolated, one-shot work; children cannot delegate. Give self-contained prompts. '
  + 'Choose one mode: single, parallel, or chain. Supports both backends. '
  + 'Set clean for work that must not be shaped by Cortex context: the child runs in a fresh '
  + 'workspace with its brief and the files you list in files, copied to inputs/. Its brief must '
  + 'stand alone, name those files as inputs/<name>, and include external paths only when the user '
  + 'explicitly authorizes access, stating the allowed operations. Its result ends with the '
  + 'workspace path, where it leaves its output.';

export const SUBAGENT_CLEAN_DESCRIPTION =
  'Run in a fresh workspace without Cortex context. Implied by files.';

export const SUBAGENT_FILES_DESCRIPTION =
  'Files or directories (absolute or ~ paths) copied into the workspace inputs/. Implies clean.';

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
  validateCleanFields(task);
}

function validateCleanFields(task: SubagentTask): void {
  if (task.clean !== undefined && typeof task.clean !== 'boolean') {
    throw new Error('Agent task clean must be a boolean.');
  }
  const files = task.files as unknown;
  if (files === undefined) return;
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string' || file.trim() === '')) {
    throw new Error('Agent task files must be a list of non-empty paths.');
  }
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
