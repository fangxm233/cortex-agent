import { MAX_SUBAGENT_CONCURRENCY } from './schema.js';
import { aggregateUsage, emptyUsage } from './usage.js';
import type {
  ChildEventForwarder, Invocation, RunChildFn, SubagentDetails, SubagentEndStatus, SubagentMode,
  SubagentResult, SubagentTask,
} from './types.js';

/** Carries one running child's events out to the parent transcript. Built per `agent` call so it
 *  can stamp the parent's tool-call id, and per child so it can stamp which of up to eight it is. */
export interface SubagentChannel {
  forChild(
    index: number,
    task: { description: string; prompt: string; subagent_type: string },
  ): ChildEventForwarder;
}

export function isFailed(result: SubagentResult): boolean {
  return result.stopReason === 'error' || result.stopReason === 'aborted';
}

/** How a settled child is reported to the parent transcript. `aborted` is `killed` rather than
 *  `failed`: the child was stopped, it did not fall over. */
export function endStatusOf(result: SubagentResult): SubagentEndStatus {
  if (result.stopReason === 'aborted') return 'killed';
  return isFailed(result) ? 'failed' : 'completed';
}

export function resultText(result: SubagentResult): string {
  if (isFailed(result)) return result.errorMessage || result.output || '(no output)';
  return result.output || '(no output)';
}

export function failedChildResult(task: SubagentTask, error: unknown): SubagentResult {
  return {
    description: task.description,
    prompt: task.prompt,
    subagentType: task.subagent_type,
    output: '',
    usage: emptyUsage(),
    backend: task.backend,
    stopReason: 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  execute: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await execute(items[index], index);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function executeParallel(
  tasks: SubagentTask[],
  runChild: RunChildFn,
  signal: AbortSignal | undefined,
  channel?: SubagentChannel,
): Promise<SubagentResult[]> {
  // The index is the task's position, not completion order: parallel children finish out of
  // order, and a block keyed by arrival would rename itself as the race resolves.
  return mapWithConcurrency(tasks, MAX_SUBAGENT_CONCURRENCY, (task, index) => (
    runChild(task, index, signal, channel?.forChild(index, task))
  ));
}

async function executeChain(
  tasks: SubagentTask[],
  runChild: RunChildFn,
  signal: AbortSignal | undefined,
  channel?: SubagentChannel,
): Promise<SubagentResult[]> {
  const results: SubagentResult[] = [];
  let previous = '';
  let index = 0;
  for (const original of tasks) {
    const task = { ...original, prompt: original.prompt.replace(/\{previous\}/g, previous) };
    const result = await runChild(task, index, signal, channel?.forChild(index, task));
    index++;
    results.push(result);
    if (isFailed(result)) break;
    previous = result.output;
  }
  return results;
}

function parallelContent(results: SubagentResult[]): string {
  const succeeded = results.filter((result) => !isFailed(result)).length;
  const sections = results.map((result) => {
    const status = isFailed(result) ? 'failed' : 'completed';
    return `### [${result.description}] ${status}\n\n${resultText(result)}`;
  });
  return `Parallel: ${succeeded}/${results.length} succeeded\n\n${sections.join('\n\n---\n\n')}`;
}

export interface SubagentToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: SubagentDetails;
}

export function buildToolResult(mode: SubagentMode, results: SubagentResult[]): SubagentToolResult {
  const details: SubagentDetails = { mode, results, usage: aggregateUsage(results) };
  if (mode === 'parallel') {
    return { content: [{ type: 'text', text: parallelContent(results) }], details };
  }
  const last = results.at(-1)!;
  const prefix = last && isFailed(last) ? 'Agent failed: ' : '';
  return { content: [{ type: 'text', text: prefix + (last ? resultText(last) : '(no output)') }], details };
}

export async function runInvocation(
  invocation: Invocation,
  runChild: RunChildFn,
  signal: AbortSignal | undefined,
  channel?: SubagentChannel,
): Promise<SubagentToolResult> {
  if (invocation.mode === 'parallel') {
    return buildToolResult('parallel', await executeParallel(invocation.tasks, runChild, signal, channel));
  }
  if (invocation.mode === 'chain') {
    return buildToolResult('chain', await executeChain(invocation.tasks, runChild, signal, channel));
  }
  const task = invocation.tasks[0];
  const result = await runChild(task, 0, signal, channel?.forChild(0, task));
  return buildToolResult('single', [result]);
}
